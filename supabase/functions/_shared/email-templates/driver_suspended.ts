// ============================================================
// TriciGo — Driver suspended email template
//
// Sent by trg_send_driver_status_email (DB trigger on
// `driver_profiles` AFTER UPDATE status) when status='suspended'.
//
// Before this template existed the trigger posted
// `template: 'driver_suspended'` which fell through to the legacy
// "template-as-HTML-string" path, so the driver got an email whose
// body was the literal word "driver_suspended". This template fixes it.
//
// data: { full_name, reason }  (reason from driver_profiles.suspended_reason, may be empty)
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow } from './_layout.ts';

export interface DriverSuspendedData {
  full_name: string;
  reason?: string;
}

export const driverSuspendedSubject = 'Tu cuenta TriciGo Conductor fue suspendida';

export function driverSuspendedHtml(data: DriverSuspendedData): string {
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
      Tu cuenta de conductor en TriciGo fue <strong style="color: ${COLORS.primary};">suspendida</strong>.
      Mientras dure la suspensión no podrás conectarte ni recibir viajes.
    </p>
    ${reasonBlock}
    <p style="margin: 16px 0 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      Si creés que se trata de un error o querés más información, contactanos
      y revisamos tu caso.
    </p>
  `;

  return wrapHtml({
    preheader: 'Tu cuenta de conductor TriciGo fue suspendida.',
    hero: {
      title: 'Cuenta suspendida',
      subtitle: 'No podrás recibir viajes mientras dure la suspensión.',
    },
    body,
    footerNote:
      'Para apelar o consultar, escribinos a soporte@tricigo.com.',
  });
}
