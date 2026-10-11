// ============================================================
// TriciGo — finish a sign-in that arrived as a link (native apps)
//
// The rule lives in @tricigo/utils/authCallback (decideAuthCallback). This file
// only gathers what it needs (who is signed in, the pending-login marker), asks
// when the rule says so, and sets the session. The apps supply the storage and
// the confirmation dialog.
// ============================================================

import {
  decideAuthCallback,
  decodeAuthTokenClaims,
  parsePendingLogin,
  type AuthCallbackTokens,
} from '@tricigo/utils/authCallback';
import { getSupabaseClient } from './client';

export type AuthCallbackOutcome =
  | 'signed_in'
  | 'declined'
  | 'failed'
  | 'invalid_token'
  | 'already_signed_in'
  | 'other_account_signed_in';

export interface AuthCallbackHooks {
  readPending: () => Promise<string | null>;
  clearPending: () => Promise<void>;
  /** Ask the user; true to go ahead. `accountLabel` is the email or phone the
   *  link opens (null when the token carries neither). */
  confirm: (accountLabel: string | null) => Promise<boolean>;
  /** The account the UI shows. Counts as signed in even when the stored session
   *  could not be read (the cached UI stays up in that case). */
  currentUserId?: () => string | null;
  now?: () => number;
}

export async function completeAuthCallback(
  tokens: AuthCallbackTokens,
  hooks: AuthCallbackHooks,
): Promise<AuthCallbackOutcome> {
  const supabase = getSupabaseClient();

  let sessionUserId: string | null = null;
  try {
    const { data } = await supabase.auth.getSession();
    sessionUserId = data.session?.user?.id ?? null;
  } catch {
    // Unreadable session: fall back to the account the UI shows.
  }

  let pendingRaw: string | null = null;
  try {
    pendingRaw = await hooks.readPending();
  } catch {
    // No marker readable: the link will need confirming.
  }

  const decision = decideAuthCallback({
    claims: decodeAuthTokenClaims(tokens.accessToken),
    currentUserId: sessionUserId ?? hooks.currentUserId?.() ?? null,
    pending: parsePendingLogin(pendingRaw),
    now: hooks.now?.() ?? Date.now(),
  });

  if (decision.action === 'ignore') return decision.reason;
  if (decision.action === 'confirm' && !(await hooks.confirm(decision.accountLabel))) return 'declined';

  const { error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error) return 'failed';
  try {
    await hooks.clearPending();
  } catch {
    // The marker expires on its own.
  }
  return 'signed_in';
}
