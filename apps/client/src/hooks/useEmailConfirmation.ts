import { useCallback, useEffect, useRef, useState } from 'react';
import { authService } from '@tricigo/api';
import type { EmailConfirmationStatus } from '@tricigo/types';
import { emailNoticeErrorKey, type EmailNoticeErrorKey } from '@tricigo/utils';
import { useRefreshOnFocus } from './useRefreshOnFocus';

export type EmailResendResult = { ok: true } | { ok: false; errorKey: EmailNoticeErrorKey };

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
  const seq = useRef(0);
  const inflightFor = useRef<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(() => {
    const req = ++seq.current;
    if (!userId) {
      inflightFor.current = null;
      setStatus(null);
      return;
    }
    // A focus while the same account's status is loading adds nothing.
    if (inflightFor.current === userId) return;
    inflightFor.current = userId;
    authService
      .getMyEmailStatus()
      .then(
        (next) => {
          if (req === seq.current) setStatus(next);
        },
        () => {},
      )
      .finally(() => {
        if (inflightFor.current === userId) inflightFor.current = null;
      });
  }, [userId]);

  useRefreshOnFocus(refresh);
  // A sign-in or account switch while the screen stays focused.
  useEffect(() => {
    setSentTo(null);
    refresh();
  }, [refresh]);

  const resend = useCallback(async (): Promise<EmailResendResult> => {
    const email = status?.status === 'unconfirmed' ? status.email : null;
    if (!email || busy.current) return { ok: false, errorKey: 'email_notice.error_generic' };
    busy.current = true;
    setResending(true);
    try {
      await authService.addBackupEmail(email);
      setSentTo(email);
      inflightFor.current = null;
      refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, errorKey: emailNoticeErrorKey((err as { code?: string } | null)?.code) };
    } finally {
      busy.current = false;
      setResending(false);
    }
  }, [status, refresh]);

  const email = status?.email ?? null;
  const linkSent = !!email && (sentTo?.toLowerCase() === email.toLowerCase() || !!status?.linkSentAt);

  return { status, resending, linkSent, resend, refresh };
}
