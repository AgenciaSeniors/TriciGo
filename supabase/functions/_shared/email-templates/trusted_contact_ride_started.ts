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

  // Highlighted "live tracking" card — subtle brand-orange panel with a
  // status pill, so the reassurance reads at a glance.
  const trackingCard = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 4px 0 24px; background: ${COLORS.primaryLight}; border-radius: 12px;">
      <tr>
        <td style="padding: 18px 20px; font-family: ${FONT_STACK};">
          <span style="display: inline-block; padding: 4px 12px; background: ${COLORS.primary}; border-radius: 999px; font-size: 12px; font-weight: 700; color: #FFFFFF; letter-spacing: 0.01em;">
            Seguimiento en vivo
          </span>
          <p style="margin: 12px 0 0; font-size: 15px; line-height: 1.55; color: ${COLORS.text};">
            Vas a ver la ubicación de <strong style="color: ${COLORS.ink};">${escapeHtml(rider)}</strong>
            en el mapa, en tiempo real, hasta que llegue a destino.
          </p>
        </td>
      </tr>
    </table>`;

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola <strong>${escapeHtml(contact)}</strong>,
    </p>
    <p style="margin: 0 0 20px;">
      <strong style="color: ${COLORS.ink};">${escapeHtml(rider)}</strong> inició un viaje con TriciGo
      y te sumó como contacto de confianza para que puedas acompañar el recorrido.
    </p>
    ${trackingCard}
    <p style="margin: 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted}; line-height: 1.5;">
      Por seguridad, el enlace de seguimiento deja de funcionar cuando el viaje termina.
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
    footerNote: 'Recibís este aviso porque sos contacto de confianza. ¿Dudas? Escribinos a soporte@tricigo.com.',
  });
}
