import { useCallback, useEffect, useRef, useState } from 'react';
import { authService } from '@tricigo/api';
import type { EmailConfirmationStatus } from '@tricigo/types';
import { createLatestLoader, emailNoticeErrorKey, type EmailNoticeErrorKey } from '@tricigo/utils';
import { useRefreshOnFocus } from './useRefreshOnFocus';

export type EmailResendResult =
  | { status: 'sent' }
  /** A resend was already running (double tap): nothing to show. */
  | { status: 'busy' }
  | { status: 'failed'; errorKey: EmailNoticeErrorKey };

/**
 * Whether the signed-in account's e-mail address is confirmed (00640
 * get_my_email_status), for the "Confirma tu correo" notice. Reloads when the
 * screen regains focus and when the app returns to the foreground, so the notice
 * goes away once the link is opened. Null without a session, or when the status
 * cannot be read (the notice then stays hidden).
 *
 * `resend()` asks add-email-with-verification for a new link to the same address.
 * `linkSent` is true after a resend in this session, or while the server holds a
 * still-valid link for that address.
 */
export function useEmailConfirmation(userId: string | null | undefined) {
  const [status, setStatus] = useState<EmailConfirmationStatus | null>(null);
  const [resending, setResending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loader] = useState(createLatestLoader);
  const busy = useRef(false);

  const refresh = useCallback(() => {
    const key = userId ?? null;
    const ticket = loader.begin(key);
    if (key === null) {
      setStatus(null);
      return;
    }
    // Same account already loading (focus and sign-in fire together on mount).
    if (ticket === null) return;
    authService.getMyEmailStatus().then(
      (next) => {
        if (loader.settle(ticket, key)) setStatus(next);
      },
      () => {
        loader.settle(ticket, key);
      },
    );
  }, [userId, loader]);

  useRefreshOnFocus(refresh);
  // A sign-in or an account switch while the screen stays focused: never show the
  // previous account's address, not even until the new answer arrives.
  useEffect(() => {
    setStatus(null);
    setSentTo(null);
    refresh();
  }, [refresh]);

  const resend = useCallback(async (): Promise<EmailResendResult> => {
    if (busy.current) return { status: 'busy' };
    const email = status?.status === 'unconfirmed' ? status.email : null;
    if (!email) return { status: 'failed', errorKey: 'email_notice.error_generic' };
    busy.current = true;
    setResending(true);
    try {
      await authService.addBackupEmail(email);
      setSentTo(email);
      loader.reset();
      refresh();
      return { status: 'sent' };
    } catch (err) {
      return { status: 'failed', errorKey: emailNoticeErrorKey((err as { code?: string } | null)?.code) };
    } finally {
      busy.current = false;
      setResending(false);
    }
  }, [status, refresh, loader]);

  const email = status?.email ?? null;
  const linkSent = !!email && (sentTo?.toLowerCase() === email.toLowerCase() || !!status?.linkSentAt);

  return { status, resending, linkSent, resend, refresh };
}
