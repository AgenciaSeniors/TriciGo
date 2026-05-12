// ============================================================
// TriciGo — Win-back email template
//
// Sent by behavioral-emails cron to riders whose last completed
// ride was 7+ days ago, max once per 30 days. Goal: nudge them
// back to the app without being pushy. No discount/promo here on
// purpose — those live in admin-curated bulk campaigns.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, WEB_ORIGIN, escapeHtml } from './_layout.ts';

export interface WinBackData {
  full_name?: string | null;
  days_since_last_ride: number;
}

export const winBackSubject = '¡Te extrañamos! Vuelve a viajar con TriciGo';

export function winBackHtml(data: WinBackData): string {
  const greetingName = data.full_name?.trim() || 'amigo';
  const days = Math.max(1, Math.floor(data.days_since_last_ride));

  // The day-count phrasing is intentionally soft — "ya pasaron N
  // días" reads warmer than "no has viajado en N días" (the latter
  // sounds like a guilt trip).
  const daysLine =
    days === 1
      ? 'Ya pasó un día desde tu último viaje.'
      : `Ya pasaron <strong>${days} días</strong> desde tu último viaje.`;

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(greetingName)}</strong> 👋
    </p>
    <p style="margin: 0 0 20px;">
      ${daysLine} Tus conductores están esperándote en La Habana, Santiago,
      Camagüey y todas las provincias.
    </p>
    <p style="margin: 0 0 24px;">
      Pedir un viaje toma 30 segundos. Sin trámites, sin esperas largas — el
      conductor llega a vos.
    </p>
  `;

  return wrapHtml({
    preheader: 'Tu próximo viaje a un toque de distancia.',
    hero: {
      title: 'Te extrañamos',
      subtitle: 'Tu próximo viaje a un toque de distancia.',
    },
    body,
    cta: { label: 'Volver a viajar', href: `${WEB_ORIGIN}/book` },
    footerNote:
      '¿Ya no querés recibir estos correos? Respondé a este mensaje y te damos de baja.',
  });
}
