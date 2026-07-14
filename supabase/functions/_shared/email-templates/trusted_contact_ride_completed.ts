// ============================================================
// TriciGo — Trusted contact: ride completed ("arrived safely")
//
// Sent by notify_trusted_contacts_on_complete (DB trigger on `rides`
// AFTER UPDATE status ->'completed') to each auto-share trusted
// contact that HAS an email on file. Contacts without an email fall
// back to SMS (D7). Migrated to email to save SMS cost (mig 00496).
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

export function trustedContactRideCompletedHtml(data: TrustedContactRideCompletedData): string {
  const contact = data.contact_name?.trim() || 'Hola';
  const rider = data.rider_name?.trim() || 'Tu contacto';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola ${escapeHtml(contact)},
    </p>
    <p style="margin: 0 0 16px;">
      <strong>${escapeHtml(rider)}</strong> llegó a su destino de forma segura. El viaje con
      TriciGo terminó.
    </p>
  `;

  return wrapHtml({
    preheader: `${rider} llegó a su destino de forma segura`,
    hero: {
      title: 'Llegó a destino ✅',
      subtitle: `${rider} completó su viaje de forma segura`,
    },
    body,
    footerNote: '¿Dudas? Escribinos a soporte@tricigo.com.',
  });
}
