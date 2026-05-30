// ============================================================
// TriciGo — New device login alert template
//
// Sent by the register-login-device EF when a user signs in from a
// device_id we've never recorded for them (and they already had at
// least one known device). Replaces GoTrue's native
// signed_in_new_device notification, which was disabled because its
// IP/user-agent heuristic flagged the same phone as "new" on every
// OTP login. Registered key: 'new_device_login'
// (data: { email, date, ip, device, os }).
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, detailRow, escapeHtml } from './_layout.ts';

export interface NewDeviceLoginData {
  email: string;
  date: string;
  ip?: string | null;
  device?: string | null;
  os?: string | null;
}

export const newDeviceLoginSubject = 'Nuevo inicio de sesión en tu cuenta TriciGo';

export function newDeviceLoginHtml(data: NewDeviceLoginData): string {
  const fallback = (v?: string | null) => (v && v.trim() ? v.trim() : 'No disponible');

  const body = `
    <p style="margin: 0 0 20px;">
      Tu cuenta TriciGo (<strong>${escapeHtml(data.email)}</strong>) se abrió desde un
      dispositivo que no reconocemos. Si fuiste vos, podés ignorar este mensaje.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px; border-collapse: collapse;">
      ${detailRow('Fecha', fallback(data.date), { strong: true })}
      ${detailRow('Dirección IP', fallback(data.ip), { strong: true })}
      ${detailRow('Dispositivo', fallback(data.device), { strong: true })}
      ${detailRow('Sistema operativo', fallback(data.os), { strong: true })}
    </table>
    <p style="margin: 24px 0 8px; font-family: ${FONT_STACK}; font-size: 16px; font-weight: 600; color: ${COLORS.ink};">
      ¿No fuiste vos?
    </p>
    <p style="margin: 0 0 12px;">
      Si no reconocés este acceso, tu cuenta podría estar comprometida. Tomá estas
      acciones cuanto antes:
    </p>
    <ol style="margin: 0 0 8px; padding-left: 20px; color: ${COLORS.text};">
      <li style="margin: 0 0 6px;">Restablecé tu contraseña desde la pantalla de inicio de sesión.</li>
      <li style="margin: 0 0 6px;">Cerrá sesión en todos tus dispositivos desde tu perfil.</li>
      <li style="margin: 0 0 6px;">Escribinos a <a href="mailto:soporte@tricigo.com" style="color: ${COLORS.primary}; text-decoration: none;">soporte@tricigo.com</a> para reportar el incidente.</li>
    </ol>
  `;

  return wrapHtml({
    preheader: 'Detectamos un nuevo inicio de sesión en tu cuenta TriciGo.',
    hero: {
      title: 'Nuevo inicio de sesión',
      subtitle: 'Detectamos un acceso desde un dispositivo nuevo a tu cuenta.',
    },
    body,
    footerNote: 'Este es un correo automático de seguridad. No respondas a esta dirección.',
  });
}
