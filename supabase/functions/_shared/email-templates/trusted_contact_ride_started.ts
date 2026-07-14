// ============================================================
// TriciGo — Trusted contact: ride started (live tracking)
//
// Sent by notify_trusted_contacts_on_accept (DB trigger on `rides`
// AFTER UPDATE status 'searching'->'accepted') to each auto-share
// trusted contact that HAS an email on file. Contacts without an
// email fall back to SMS (D7). Migrated to email to save SMS cost
// (mig 00496). The CTA points at the public live-tracking page
// https://tricigo.com/track/share/<token>.
//
// data: { contact_name, rider_name, share_url }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface TrustedContactRideStartedData {
  contact_name: string;
  rider_name: string;
  share_url: string;
}

export const trustedContactRideStartedSubject = '🚗 Un viaje en curso — TriciGo';

export function trustedContactRideStartedHtml(data: TrustedContactRideStartedData): string {
  const contact = data.contact_name?.trim() || 'Hola';
  const rider = data.rider_name?.trim() || 'Alguien';
  const url = data.share_url?.trim() || '';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola ${escapeHtml(contact)},
    </p>
    <p style="margin: 0 0 16px;">
      <strong>${escapeHtml(rider)}</strong> inició un viaje con TriciGo y te agregó como
      contacto de confianza. Podés seguir el viaje en tiempo real desde el botón de abajo.
    </p>
    <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted};">
      Este enlace de seguimiento deja de funcionar cuando el viaje termina.
    </p>
  `;

  return wrapHtml({
    preheader: `${rider} inició un viaje — seguilo en vivo`,
    hero: {
      title: 'Viaje en curso 🚗',
      subtitle: `${rider} está viajando con TriciGo`,
    },
    body,
    cta: url ? { label: 'Ver viaje en vivo', href: url } : undefined,
    footerNote: '¿Dudas? Escribinos a soporte@tricigo.com.',
  });
}
