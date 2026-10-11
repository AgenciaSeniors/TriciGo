// ============================================================
// Account deletion — the database step (00657).
//
// prepare_account_deletion(user) runs the gates, the wallet settlement and the
// re-pointing of every reference to the anonymous user in ONE transaction. The
// delete-account and admin-delete-pending-account Edge Functions call it before
// asking GoTrue to delete the auth user, so a refusal or a failure leaves the
// account, its money and its history exactly as they were.
//
// Before 00657 the two steps ran as separate RPCs: a failed re-pointing (a
// unique key at the anonymous user) left the wallet already moved to the
// platform and the account impossible to delete.
//
// Until 00657 is applied, the function does not exist (PostgREST PGRST202) and
// this module falls back to the two old RPCs, so the Edge Functions can be
// deployed before the migration.
//
// Pure module: no remote imports, no Deno, so packages/api's vitest runs it.
// ============================================================

export interface RpcError {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

/** Refusals the account owner can act on; each carries a Spanish message. */
export const DELETION_REFUSALS = [
  'deletion_system_account',
  'deletion_active_ride',
  'deletion_open_case',
  'deletion_debt',
  'deletion_payment_pending',
] as const;

export type DeletionRefusal = (typeof DELETION_REFUSALS)[number];

export type PrepareOutcome =
  | { ok: true; settled: unknown; anonymized: unknown; legacy: boolean }
  | {
      ok: false;
      status: number;
      /** deletion_* code, or deletion_failed when the cause is internal. */
      error: string;
      /** Spanish text for the person; null when there is nothing they can do. */
      message: string | null;
      /** Internal detail for the logs (never sent to the client). */
      log: string;
    };

function isMissingFunction(err: RpcError): boolean {
  return (
    err.code === 'PGRST202' ||
    /could not find the function/i.test(err.message ?? '')
  );
}

function isRefusal(detail: string | null | undefined): detail is DeletionRefusal {
  return (DELETION_REFUSALS as readonly string[]).includes(detail ?? '');
}

/** Columns that anonymize_user_references could not move (it reports, not raises). */
export function failedAnonymizations(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  return Object.entries(result as Record<string, unknown>)
    .filter(([, v]) => v !== null && typeof v === 'object' && 'error' in (v as object))
    .map(([k]) => k)
    .sort();
}

async function legacyPrepare(admin: RpcClient, userId: string): Promise<PrepareOutcome> {
  const settle = await admin.rpc('settle_and_scrub_for_deletion', { p_user_id: userId });
  if (settle.error) {
    return {
      ok: false,
      status: 500,
      error: 'deletion_failed',
      message: null,
      log: `settle_failed: ${settle.error.message ?? ''}`,
    };
  }
  const anon = await admin.rpc('anonymize_user_references', { p_user_id: userId });
  if (anon.error) {
    return {
      ok: false,
      status: 500,
      error: 'deletion_failed',
      message: null,
      log: `anonymize_failed: ${anon.error.message ?? ''}`,
    };
  }
  // The auth delete would fail on the reference that stayed behind anyway; stop
  // here so the logs say which one.
  const failed = failedAnonymizations(anon.data);
  if (failed.length > 0) {
    return {
      ok: false,
      status: 500,
      error: 'deletion_incomplete',
      message: 'No pudimos eliminar tu cuenta. Escríbenos a soporte.',
      log: `anonymize_incomplete: ${failed.join(', ')}`,
    };
  }
  return { ok: true, settled: settle.data, anonymized: anon.data, legacy: true };
}

export async function prepareAccountDeletion(
  admin: RpcClient,
  userId: string,
): Promise<PrepareOutcome> {
  const { data, error } = await admin.rpc('prepare_account_deletion', { p_user_id: userId });
  if (!error) {
    const res = (data ?? {}) as { settled?: unknown; anonymized?: unknown };
    return { ok: true, settled: res.settled ?? null, anonymized: res.anonymized ?? null, legacy: false };
  }

  if (isMissingFunction(error)) return legacyPrepare(admin, userId);

  if (isRefusal(error.details)) {
    return {
      ok: false,
      status: error.details === 'deletion_system_account' ? 403 : 409,
      error: error.details,
      message: error.message ?? null,
      log: error.details,
    };
  }

  if (error.details === 'deletion_incomplete') {
    return {
      ok: false,
      status: 500,
      error: 'deletion_incomplete',
      message: error.message ?? null,
      log: `deletion_incomplete: ${error.hint ?? ''}`,
    };
  }

  return {
    ok: false,
    status: 500,
    error: 'deletion_failed',
    message: null,
    log: `prepare_failed: ${error.code ?? ''} ${error.message ?? ''}`,
  };
}
