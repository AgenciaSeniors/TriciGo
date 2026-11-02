// ============================================================
// TriciGo — calling the panel's ops functions (00672, 00673)
//
// The ops functions answer {error: code} when they refuse; that becomes an AppError with the code,
// which the panel turns into a text (apps/admin/src/lib/opsErrors.ts). A function the database does
// not have yet (its migration not applied) becomes the caller's "unavailable" code.
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

interface RpcError {
  code?: string;
  message?: string;
}

export function isMissingRpc(error: RpcError | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202'
    || /could not find the function|not found in the schema cache/i.test(error.message ?? ''));
}

/** The text without surrounding spaces, or null when nothing is left. */
export function trimmedText(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

/** Calls an ops function; `{ error: code }` becomes an AppError with that code. */
export async function callOpsRpc(rpc: string, args: Record<string, unknown>,
                                 unavailableCode: string): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) {
    if (isMissingRpc(error)) throw new AppError(`${rpc} is not deployed yet`, unavailableCode, 503);
    throw error;
  }
  const result = (data ?? {}) as Record<string, unknown>;
  const code = result.error;
  if (typeof code === 'string' && code) {
    throw new AppError(`${rpc} refused: ${code}`, code, 409, result);
  }
  return result;
}
