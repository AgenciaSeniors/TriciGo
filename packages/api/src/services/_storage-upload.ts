// ============================================================
// TriciGo — Storage upload helper (RN-safe, Edge-Function-routed)
// ============================================================

import { getSupabaseClient } from '../client';

/**
 * Upload a local file (native `file://`, `content://`, or `ph://` URI on RN)
 * to a Supabase Storage bucket via the `storage-upload` Edge Function.
 *
 * WHY an Edge Function and not a direct `supabase.storage.from().upload()`:
 * since the publishable-key (`sb_publishable_`) migration, the Storage service
 * rejects the session's user JWT (treats the request as `anon`), so the
 * `authenticated`-only Storage RLS INSERT policies fail with "new row violates
 * row-level security policy" — even though PostgREST + gotrue validate the same
 * token fine. (Same root cause + fix as the delivery photo, PR #430.) The
 * `storage-upload` EF authenticates the caller via gotrue, enforces a strict
 * per-bucket authorization that mirrors each bucket's RLS, then uploads with the
 * service-role key. `supabase.functions.invoke` attaches the session JWT — the
 * same path the other working EFs use on mobile.
 *
 * WHY FormData with the RN file descriptor `{ uri, name, type }`:
 * on React Native `fetch(uri)` does NOT support the `file://`/`content://`/`ph://`
 * schemes, so `await fetch(uri).blob()` throws "Network request failed". FormData
 * with the descriptor is the canonical RN-safe path. (Web callers that already
 * hold a Blob — e.g. the web avatar crop — invoke the EF directly with the Blob
 * instead of going through this helper.)
 *
 * Callers are otherwise unchanged: they still build the storagePath, then call
 * `getPublicUrl` (pure client-side) and write their own DB row via PostgREST
 * afterward (PostgREST validates the JWT fine — only Storage was broken).
 *
 * WHY a timeout + retry (Cuban connectivity):
 * `supabase.functions.invoke` has NO built-in timeout. On a flaky edge/3G link
 * the request can hang indefinitely — the UI shows an infinite spinner that
 * users perceive as a freeze ("se bloquea"). We race the invoke against a hard
 * timeout so a stalled upload becomes a clear, surfaced error, and we auto-retry
 * once on a timeout/network-class failure (the common transient case in Cuba).
 * A real denial (forbidden/too_large/etc. — a `{ error }` body) is NOT retried.
 * Retrying is safe: idempotent paths (avatar upsert to a fixed path, docs keyed
 * by docType) simply overwrite; timestamped paths (selfie/dispute) at worst
 * leave a harmless orphan object.
 *
 * Throws on failure (gateway error, timeout, or an `{ error }` body from the EF).
 */

/** Hard ceiling for a single upload attempt. Cuban 3G is slow but a compressed
 *  image is ~150–400 KB, so 45s is generous while still bounding the hang. */
const UPLOAD_TIMEOUT_MS = 45_000;
/** Total attempts (1 initial + retries) on a timeout/network-class failure. */
const UPLOAD_MAX_ATTEMPTS = 2;
/** Backoff before the retry. */
const UPLOAD_RETRY_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Marks an error as a transient timeout/network failure worth retrying. */
class UploadTransientError extends Error {}

export async function uploadFileFromUri(
  bucket: string,
  storagePath: string,
  uri: string,
  opts: { fileName: string; mimeType?: string; upsert?: boolean },
): Promise<void> {
  const supabase = getSupabaseClient();

  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    // Rebuild FormData per attempt — a FormData body can only be consumed once.
    const formData = new FormData();
    formData.append('file', {
      uri,
      name: opts.fileName,
      type: opts.mimeType ?? 'image/jpeg',
    } as unknown as Blob);
    formData.append('bucket', bucket);
    formData.append('path', storagePath);
    formData.append('upsert', String(opts.upsert ?? false));
    if (opts.mimeType) formData.append('contentType', opts.mimeType);

    try {
      await invokeStorageUpload(supabase, formData);
      return;
    } catch (err) {
      lastError = err;
      // Only timeouts/network blips are retried; a real EF denial is final.
      if (err instanceof UploadTransientError && attempt < UPLOAD_MAX_ATTEMPTS) {
        await sleep(UPLOAD_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  // Unreachable (loop either returns or throws), but keeps the type checker happy.
  throw lastError instanceof Error ? lastError : new Error('upload_failed');
}

/**
 * One invoke attempt, raced against a hard timeout. Resolves on success; throws
 * `UploadTransientError` on a timeout (retryable) and a plain `Error` on a real
 * EF/gateway failure (not retryable). Note: the timeout unblocks the UI but does
 * not cancel the underlying fetch — supabase-js 2.49 `invoke` takes no signal;
 * a stalled request is simply abandoned.
 */
async function invokeStorageUpload(
  supabase: ReturnType<typeof getSupabaseClient>,
  formData: FormData,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new UploadTransientError('upload_timeout')),
      UPLOAD_TIMEOUT_MS,
    );
  });

  try {
    const { data, error } = await Promise.race([
      supabase.functions.invoke('storage-upload', { body: formData }),
      timeout,
    ]);
    if (error) {
      // On a non-2xx the EF returns { error, reason } (e.g. `db_error` for a
      // transient DB/connection blip vs a bare `forbidden` for a real denial).
      // supabase-js sets `error` (FunctionsHttpError) with the parsed body in
      // `error.context` — pull it out so the real cause reaches the UI instead of
      // the opaque "Edge Function returned a non-2xx status code". Best-effort:
      // gateway-level errors have no JSON body, so fall back to error.message.
      let detail = error.message;
      let hasJsonBody = false;
      try {
        const body = await (error as { context?: Response }).context?.json?.();
        if (body?.error) {
          hasJsonBody = true;
          detail = body.reason ? `${body.error}: ${body.reason}` : body.error;
        }
      } catch {
        /* no JSON body — keep error.message */
      }
      // A structured `{ error }` body is a deliberate EF response (denial /
      // validation) → final. A bodyless FunctionsFetchError is a network-level
      // failure (DNS/TLS/connection reset on a bad link) → retryable.
      if (!hasJsonBody && /FunctionsFetchError|fetch|network/i.test(error.name ?? '')) {
        throw new UploadTransientError(detail);
      }
      throw new Error(detail);
    }
    const errBody = (data as { error?: string } | null)?.error;
    if (errBody) throw new Error(String(errBody));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
