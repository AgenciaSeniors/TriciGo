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
 * Throws on failure (gateway error or an `{ error }` body from the EF).
 */
export async function uploadFileFromUri(
  bucket: string,
  storagePath: string,
  uri: string,
  opts: { fileName: string; mimeType?: string; upsert?: boolean },
): Promise<void> {
  const supabase = getSupabaseClient();

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

  const { data, error } = await supabase.functions.invoke('storage-upload', {
    body: formData,
  });
  if (error) throw error;
  const errBody = (data as { error?: string } | null)?.error;
  if (errBody) throw new Error(String(errBody));
}
