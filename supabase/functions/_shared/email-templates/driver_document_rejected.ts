// ============================================================
// TriciGo — Driver document rejected email template
//
// Sent by the notify-document-rejection EF (invoked from the
// admin app's adminService.verifyDocument) when an admin
// rejects a single driver document via the multi-select chip
// flow in /drivers/[id]. Not the same as `driver_rejected` —
// THAT one fires when the whole driver application is rejected
// (driver_profiles.status -> 'rejected').
//
// data:
//   - full_name: driver display name (greeting)
//   - document_label: localized doc type label ("Cédula",
//     "Licencia de conducción", etc.)
//   - reason_labels: array of localized rejection reasons from
//     the admin's chip selection ("Foto borrosa o ilegible", ...)
//   - note: optional free-text the admin added below the chips
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, ctaButton, WEB_ORIGIN } from './_layout.ts';

export interface DriverDocumentRejectedData {
  full_name: string;
  document_label: string;
  reason_labels: string[];
  note?: string;
}

export const driverDocumentRejectedSubject = 'Tu documento en TriciGo necesita una revisión';

export function driverDocumentRejectedHtml(data: DriverDocumentRejectedData): string {
  const name = data.full_name?.trim() || 'Hola';
  const docLabel = escapeHtml(data.document_label?.trim() || 'tu documento');
  const reasons = (data.reason_labels ?? []).filter((r) => r && r.trim().length > 0);
  const note = data.note?.trim();

  const reasonsList = reasons.length > 0
    ? `
      <p style="margin: 16px 0 8px; font-family: ${FONT_STACK}; font-size: 14px; font-weight: 600; color: ${COLORS.ink};">
        Motivos:
      </p>
      <ul style="margin: 0 0 16px; padding: 0 0 0 20px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
        ${reasons.map((r) => `<li style="margin: 0 0 4px;">${escapeHtml(r)}</li>`).join('')}
      </ul>
    `
    : '';

  const noteBlock = note
    ? `
      <div style="margin: 16px 0; padding: 12px 14px; background: #FFF7ED; border-left: 3px solid ${COLORS.primary}; border-radius: 4px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.ink}; line-height: 1.6;">
        <strong style="display: block; margin-bottom: 4px; font-size: 12px; color: ${COLORS.primary}; text-transform: uppercase; letter-spacing: 0.5px;">Nota del equipo</strong>
        ${escapeHtml(note)}
      </div>
    `
    : '';

  const cta = ctaButton('Volver a subir el documento', `${WEB_ORIGIN}/app/driver/profile/documents`);

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(name)}</strong>.
    </p>
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 15px; color: ${COLORS.text}; line-height: 1.6;">
      Revisamos tu <strong>${docLabel}</strong> y por ahora <strong>no pudimos aprobarlo</strong>.
    </p>
    ${reasonsList}
    ${noteBlock}
    <p style="margin: 16px 0 24px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      Volvé a subir el documento desde la app y nuestro equipo lo revisará nuevamente. Si creés que esto fue un error, contactanos a soporte@tricigo.com.
    </p>
    ${cta}
  `;

  return wrapHtml({
    preheader: 'Volvé a subir el documento desde la app para que lo revisemos de nuevo.',
    hero: {
      title: 'Necesitamos otra revisión',
      subtitle: 'Tu documento no pasó la verificación inicial.',
    },
    body,
    footerNote:
      '¿Preguntas sobre tu documento? Escribinos a soporte@tricigo.com.',
  });
}
