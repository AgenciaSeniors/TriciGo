// ============================================================
// TriciGo — Driver rejected email template
//
// Sent by trg_send_driver_status_email (DB trigger on
// `driver_profiles` AFTER UPDATE status) when status='rejected'.
//
// Before this template existed the trigger posted
// `template: 'driver_rejected'` which fell through to the legacy
// "template-as-HTML-string" path, so the applicant got an email
// whose body was the literal word "driver_rejected". This template
// fixes it.
//
// data: { full_name, reason }  (reason may be empty)
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow } from './_layout.ts';

export interface DriverRejectedData {
  full_name: string;
  reason?: string;
}

export const driverRejectedSubject = 'Tu solicitud TriciGo Conductor — actualización';

export function driverRejectedHtml(data: DriverRejectedData): string {
  const name = data.full_name?.trim() || 'Hola';
  const reason = data.reason?.trim();

  const reasonBlock = reason
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">${detailRow('Motivo', reason)}</table>`
    : '';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(name)}</strong>.
    </p>
    <p style="margin: 0 0 16px;">
      Revisamos tu solicitud para ser conductor en TriciGo y por ahora
      <strong>no pudimos aprobarla</strong>.
    </p>
    ${reasonBlock}
    <p style="margin: 16px 0 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      Podés volver a postularte corrigiendo lo indicado. Si creés que se trata
      de un error, contactanos y lo revisamos.
    </p>
  `;

  return wrapHtml({
    preheader: 'Actualización sobre tu solicitud de conductor en TriciGo.',
    hero: {
      title: 'Actualización de tu solicitud',
      subtitle: 'Revisá los detalles y volvé a postularte.',
    },
    body,
    footerNote:
      '¿Preguntas sobre tu solicitud? Escribinos a soporte@tricigo.com.',
  });
}
