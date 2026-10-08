'use client';

import React, { useState } from 'react';
import { authService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { emailNoticeErrorKey, type EmailNoticeErrorKey } from '@tricigo/utils';

/**
 * "Confirma tu correo" (00643) under the address while it is unconfirmed: since
 * 00635 no receipt or account notice reaches an address its owner never proved.
 * Not dismissible. Colors are the paired light/dark warning surface tokens.
 */
export function EmailConfirmNotice({
  email,
  linkSentAt,
  onLinkSent,
}: {
  email: string;
  /** When the newest still-valid link was sent (get_my_email_status), or null. */
  linkSentAt: string | null;
  onLinkSent: () => void;
}) {
  const { t } = useTranslation('common');
  const [resending, setResending] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorKey, setErrorKey] = useState<EmailNoticeErrorKey | null>(null);

  const resend = async () => {
    if (resending) return;
    setResending(true);
    setErrorKey(null);
    try {
      await authService.addBackupEmail(email);
      setSent(true);
      onLinkSent();
    } catch (err) {
      setErrorKey(emailNoticeErrorKey((err as { code?: string } | null)?.code));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="profile-email-notice">
      <div className="profile-email-notice-row">
        <span className="profile-email-notice-state">
          <span className="profile-email-notice-dot" aria-hidden="true" />
          {t('email_notice.unconfirmed', { defaultValue: 'Sin confirmar' })}
        </span>
        <button
          type="button"
          className="profile-email-notice-action"
          onClick={resend}
          disabled={resending}
          aria-busy={resending}
          aria-label={t('email_notice.resend_a11y', {
            email,
            defaultValue: 'Reenviar el enlace de confirmación a {{email}}',
          })}
        >
          {t('email_notice.resend', { defaultValue: 'Reenviar enlace' })}
        </button>
      </div>
      <p className="profile-email-notice-message" role={errorKey ? 'alert' : 'status'} aria-live="polite">
        {errorKey
          ? t(errorKey)
          : sent || linkSentAt
            ? t('email_notice.sent', {
                email,
                defaultValue: 'Enlace enviado a {{email}}. Revisa tu correo, también la carpeta de spam.',
              })
            : t('email_notice.body', { defaultValue: 'Sin confirmarlo no te llegan recibos ni avisos de tu cuenta.' })}
      </p>
    </div>
  );
}
