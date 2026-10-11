// The "Confirma tu correo" notice (spec 2026-10-08): who sees it, and what a failed resend says.
import type { EmailConfirmationState } from '@tricigo/types';
import { realEmail } from './validation';

/** "Ahora no" hides the driver home banner this long; it comes back if still unconfirmed. */
export const EMAIL_NOTICE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The home banner shows for an unconfirmed address, unless it was dismissed less than
 * EMAIL_NOTICE_SNOOZE_MS ago. A dismissal in the future (the clock moved back) or an
 * unreadable one does not hide it.
 */
export function emailNoticeVisible(
  status: EmailConfirmationState | null | undefined,
  dismissedAtMs: number | null,
  nowMs: number,
): boolean {
  if (status !== 'unconfirmed') return false;
  if (dismissedAtMs === null || !Number.isFinite(dismissedAtMs)) return true;
  if (dismissedAtMs > nowMs) return true;
  return nowMs - dismissedAtMs >= EMAIL_NOTICE_SNOOZE_MS;
}

export type EmailNoticeErrorKey =
  | 'email_notice.error_rate_limited'
  | 'email_notice.error_taken'
  | 'email_notice.error_generic';

/** The common.json key of the message for a failed resend (authService.addBackupEmail error code). */
export function emailNoticeErrorKey(code: string | null | undefined): EmailNoticeErrorKey {
  if (code === 'rate_limited') return 'email_notice.error_rate_limited';
  if (code === 'email_already_taken') return 'email_notice.error_taken';
  return 'email_notice.error_generic';
}

/**
 * What an Editar perfil save does with the address field. `users.email` is written
 * directly only to clear it: rewriting the same address with other capitals would
 * clear its confirmation (00611), and a new one goes through
 * add-email-with-verification alone, which checks that no other account holds it,
 * stores it lowercased and mails the confirmation link (00635).
 * `current` is users.email; the phone-OTP placeholder counts as no address.
 */
export function profileEmailSavePlan(
  typed: string,
  current: string | null | undefined,
): { clear: boolean; send: string | null } {
  const next = typed.trim();
  const changed = next.toLowerCase() !== (realEmail(current) ?? '').toLowerCase();
  if (!changed) return { clear: false, send: null };
  return next ? { clear: false, send: next } : { clear: true, send: null };
}
