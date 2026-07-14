// ============================================================
// TriciGo — Trusted contact: ride completed ("arrived safely")
//
// Sent by notify_trusted_contacts_on_complete (DB trigger on `rides`
// AFTER UPDATE status ->'completed') to each auto-share trusted
// contact that HAS an email on file. Contacts without an email fall
// back to SMS (D7). Migrated to email to save SMS cost (mig 00497).
// No CTA — this is a plain "arrived safely" notice.
//
// data: { contact_name, rider_name }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface TrustedContactRideCompletedData {
  contact_name: string;
  rider_name: string;
}

export const trustedContactRideCompletedSubject = '✅ Llegó a su destino — TriciGo';

// Success accent (green-50 panel + green-600 pill) — local so the
// template stays self-contained; brand tokens don't carry a green tint.
const SUCCESS_BG = '#F0FDF4';

export function trustedContactRideCompletedHtml(data: TrustedContactRideCompletedData): string {
  const contact = data.contact_name?.trim() || 'Hola';
  const rider = data.rider_name?.trim() || 'Tu contacto';

  const arrivedCard = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 4px 0 8px; background: ${SUCCESS_BG}; border-radius: 12px;">
      <tr>
        <td style="padding: 18px 20px; font-family: ${FONT_STACK};">
          <span style="display: inline-block; padding: 4px 12px; background: ${COLORS.success}; border-radius: 999px; font-size: 12px; font-weight: 700; color: #FFFFFF; letter-spacing: 0.01em;">
            Viaje finalizado
          </span>
          <p style="margin: 12px 0 0; font-size: 15px; line-height: 1.55; color: ${COLORS.text};">
            <strong style="color: ${COLORS.ink};">${escapeHtml(rider)}</strong> llegó a su destino
            de forma segura. El seguimiento en vivo ya se cerró.
          </p>
        </td>
      </tr>
    </table>`;

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola <strong>${escapeHtml(contact)}</strong>,
    </p>
    <p style="margin: 0 0 20px;">
      Buenas noticias: el viaje que estabas siguiendo terminó bien.
    </p>
    ${arrivedCard}
  `;

  return wrapHtml({
    preheader: `${rider} llegó a su destino de forma segura`,
    hero: {
      title: 'Llegó a destino ✅',
      subtitle: `${rider} completó su viaje de forma segura`,
    },
    body,
    footerNote: 'Recibís este aviso porque sos contacto de confianza. ¿Dudas? Escribinos a soporte@tricigo.com.',
  });
}
