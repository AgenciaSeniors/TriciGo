// ============================================================
// TriciGo — Email verification template
//
// Sent by the add-email-with-verification EF when a logged-in user
// adds/changes their email. Carries the one-time link (our own token,
// not a session link) that confirms the new address. Registered key:
// 'email_verification' (data: { email, verification_link }).
// Was unregistered before, so send-email 400'd and the email was
// silently never sent.
//
// No greeting by name (2026-10-07). The recipient is whatever address
// the account typed, so it can be a stranger, and full_name is written
// by the account's owner: rendering it put the owner's own text (a
// link, a phone number) in an e-mail from noreply@tricigo.com.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface EmailVerificationData {
  email: string;
  verification_link: string;
}

export const emailVerificationSubject = 'Confirmá tu correo en TriciGo';

export function emailVerificationHtml(data: EmailVerificationData): string {
  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola:
    </p>
    <p style="margin: 0 0 20px;">
      Para terminar de agregar <strong>${escapeHtml(data.email)}</strong> a tu cuenta
      TriciGo, confirmá que este correo es tuyo tocando el botón de abajo.
    </p>
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.muted};">
      El enlace expira en una hora.
    </p>
    <p style="margin: 0;">
      Si no agregaste este correo a una cuenta TriciGo, podés ignorar este mensaje.
    </p>
  `;

  return wrapHtml({
    preheader: 'Confirmá tu correo para terminar de agregarlo a tu cuenta.',
    hero: {
      title: 'Confirmá tu correo',
      subtitle: 'Un paso más para asegurar tu cuenta.',
    },
    body,
    cta: { label: 'Confirmar correo', href: data.verification_link },
    footerNote: '¿No fuiste vos? Escribinos a soporte@tricigo.com',
  });
}
