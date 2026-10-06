// ============================================================
// TriciGo Driver — "Código de invitación" error copy
// referralService.applyInviteCode (00619) takes either an
// acquisition code (influencer, QR bag, driver group) or a
// friend's referral code. A code that is neither falls through to
// applyReferralCode, which throws "Código de referido inválido".
// The field no longer says "referral", so that message is replaced
// with the invite-code one; every other error keeps its text.
//
// Plain TypeScript, so the driver's vitest setup can test it.
// ============================================================

/** What applyReferralCode throws when a code matches nothing. */
export const INVALID_REFERRAL_CODE_MESSAGE = 'Código de referido inválido';

/**
 * The message to show when applying an invite code failed: `invalidCodeMessage`
 * for a code that does not exist, the error's own message otherwise, and
 * `undefined` when there is nothing readable to show.
 */
export function inviteCodeErrorMessage(err: unknown, invalidCodeMessage: string): string | undefined {
  if (!(err instanceof Error)) return undefined;
  return err.message === INVALID_REFERRAL_CODE_MESSAGE ? invalidCodeMessage : err.message;
}
