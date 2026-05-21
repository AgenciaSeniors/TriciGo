// ============================================================
// TriciGo — Welcome email template
//
// Sent by behavioral-emails cron once, ~24h after signup, to users
// who haven't received a welcome email yet. Goal: orient new riders
// on what TriciGo offers (5-tier service, in-app wallet, coverage
// across Cuba) and remove the "first ride" friction with a clear
// CTA to /book.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, WEB_ORIGIN, escapeHtml } from './_layout.ts';

export interface WelcomeData {
  full_name?: string | null;
}

export const welcomeSubject = '¡Bienvenido a TriciGo!';

export function welcomeHtml(data: WelcomeData): string {
  const greetingName = data.full_name?.trim() || 'viajero';

  // Body fragment — three short value-prop lines, then CTA. Avoid
  // the "feature dump" anti-pattern; rider needs ONE next action,
  // which is to request their first ride.
  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(greetingName)}</strong> 👋
    </p>
    <p style="margin: 0 0 20px;">
      Te damos la bienvenida a <strong>TriciGo</strong>, la app cubana de movilidad.
      Estamos en las 16 provincias y 168 municipios de Cuba — desde Pinar del Río
      hasta Guantánamo.
    </p>
    <p style="margin: 0 0 12px; font-family: ${FONT_STACK}; font-size: 14px; font-weight: 600; color: ${COLORS.ink};">
      Lo que podés hacer:
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 24px;">
      ${valuePropRow('🛺', 'Pedir un viaje en triciclo, moto, auto o confort.')}
      ${valuePropRow('🎟️', 'Pagar en efectivo o con tus créditos TriciCoin.')}
      ${valuePropRow('📦', 'Enviar paquetes con nuestro servicio de mensajería.')}
    </table>
    <p style="margin: 0;">
      ¿Listo para tu primer viaje? Tocá el botón de abajo.
    </p>
  `;

  return wrapHtml({
    preheader: '¡Bienvenido a TriciGo! Tu primer viaje te espera.',
    hero: {
      title: '¡Bienvenido a bordo!',
      subtitle: 'Movilidad cubana, en la palma de tu mano.',
    },
    body,
    cta: { label: 'Pedir mi primer viaje', href: `${WEB_ORIGIN}/book` },
    footerNote: '¿Necesitás ayuda? Escribinos a soporte@tricigo.com',
  });
}

// ── Internal helpers ─────────────────────────────────────────────

function valuePropRow(emoji: string, text: string): string {
  return `
    <tr>
      <td style="padding: 6px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text};">
        <span style="display: inline-block; width: 24px; vertical-align: top;">${emoji}</span>
        <span style="display: inline-block; width: calc(100% - 32px); vertical-align: top;">${escapeHtml(text)}</span>
      </td>
    </tr>`;
}
