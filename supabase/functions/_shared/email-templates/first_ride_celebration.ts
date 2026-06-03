// ============================================================
// TriciGo — First ride celebration email template
//
// Sent by trg_send_first_ride_email (DB trigger on `rides` AFTER
// UPDATE status='completed', passenger mode) when the rider's
// completed-ride count is exactly 1. A warm "thanks for your first
// trip" nudge.
//
// Before this template existed the trigger posted
// `template: 'first_ride_celebration'` which fell through to the
// legacy "template-as-HTML-string" path, so the rider got an email
// whose body was the literal word "first_ride_celebration". This
// template fixes it.
//
// data: { full_name }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, WEB_ORIGIN } from './_layout.ts';

export interface FirstRideCelebrationData {
  full_name: string;
}

export const firstRideCelebrationSubject = '🎉 Tu primer viaje — TriciGo';

export function firstRideCelebrationHtml(data: FirstRideCelebrationData): string {
  const name = data.full_name?.trim() || 'pasajero';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      ¡Gracias por tu primer viaje, <strong>${escapeHtml(name)}</strong>!
    </p>
    <p style="margin: 0 0 16px;">
      Esperamos que la pasada haya sido cómoda. Con TriciGo te movés por toda
      Cuba — del triciclo de tu barrio al auto para distancias largas.
    </p>
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 15px; font-weight: 600; color: ${COLORS.ink};">
      Algunos tips:
    </p>
    <ul style="margin: 0 0 8px; padding-left: 20px; color: ${COLORS.text}; line-height: 1.6;">
      <li style="margin: 0 0 6px;">Guardá tus direcciones frecuentes para pedir más rápido.</li>
      <li style="margin: 0 0 6px;">Cargá créditos TriciCoin y pagá sin efectivo.</li>
      <li style="margin: 0 0 6px;">Calificá a tu conductor para ayudar a la comunidad.</li>
    </ul>
  `;

  return wrapHtml({
    preheader: '¡Gracias por tu primer viaje con TriciGo!',
    hero: {
      title: '¡Tu primer viaje! 🎉',
      subtitle: 'Gracias por viajar con TriciGo.',
    },
    body,
    cta: { label: 'Pedir otro viaje', href: WEB_ORIGIN },
    footerNote:
      '¿Algo para mejorar? Escribinos a soporte@tricigo.com.',
  });
}
