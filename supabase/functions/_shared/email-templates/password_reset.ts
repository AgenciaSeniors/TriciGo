// ============================================================
// TriciGo — Password reset email template
//
// Sent by the request-password-reset EF when a user starts the
// email recovery flow. Carries the Supabase recovery magic link.
// Registered key: 'password_reset' (data: { full_name, reset_link }).
// Before this template existed the key was unregistered, so send-email
// fell to the legacy path, had no subject, and 400'd — the reset email
// was silently never sent.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface PasswordResetData {
  full_name?: string | null;
  reset_link: string;
}

export const passwordResetSubject = 'Restablecé tu contraseña de TriciGo';

export function passwordResetHtml(data: PasswordResetData): string {
  const greetingName = data.full_name?.trim() || 'viajero';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(greetingName)}</strong>
    </p>
    <p style="margin: 0 0 20px;">
      Recibimos una solicitud para restablecer la contraseña de tu cuenta TriciGo.
      Tocá el botón de abajo para elegir una nueva.
    </p>
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.muted};">
      Por seguridad, este enlace expira en una hora y solo puede usarse una vez.
    </p>
    <p style="margin: 0;">
      Si no pediste este cambio, podés ignorar este correo: tu contraseña actual
      sigue funcionando.
    </p>
  `;

  return wrapHtml({
    preheader: 'Restablecé la contraseña de tu cuenta TriciGo.',
    hero: {
      title: 'Restablecer contraseña',
      subtitle: 'Elegí una nueva contraseña para tu cuenta.',
    },
    body,
    cta: { label: 'Restablecer contraseña', href: data.reset_link },
    footerNote: '¿No fuiste vos? Escribinos a soporte@tricigo.com',
  });
}
