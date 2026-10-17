// ============================================================
// TriciGo — Team invitation code e-mail (00664)
//
// Sent by the Edge Function team-invitation-code to the invited address: the
// 6-digit code that lets the person accept their admin panel invitation, by
// creating their account or setting a password on the one with that address.
// data: { code, email }. The code is the only thing this e-mail proves.
// Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface TeamInvitationCodeData {
  code: string;
  email: string;
}

export const teamInvitationCodeSubject = 'Tu código para el panel de TriciGo';

const CODE_RE = /^[0-9]{6}$/;

export function teamInvitationCodeHtml(data: TeamInvitationCodeData): string {
  const code = CODE_RE.test(data.code) ? data.code : '';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola:
    </p>
    <p style="margin: 0 0 16px;">
      Usa este código para aceptar tu invitación al panel de TriciGo con <strong>${escapeHtml(data.email)}</strong>:
    </p>
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: ${COLORS.ink};">
      ${code}
    </p>
    <p style="margin: 0 0 16px;">
      Vence en 10 minutos.
    </p>
    <p style="margin: 0;">
      Si no pediste este código, ignora este correo. Nadie de TriciGo te lo va a pedir.
    </p>
  `;

  return wrapHtml({
    preheader: code ? `Tu código: ${code}. Vence en 10 minutos.` : 'Tu código para el panel de TriciGo.',
    hero: {
      title: 'Tu código para el panel',
      subtitle: 'Panel de administración de TriciGo',
    },
    body,
    footerNote: '¿Dudas? Escríbenos a soporte@tricigo.com',
  });
}
