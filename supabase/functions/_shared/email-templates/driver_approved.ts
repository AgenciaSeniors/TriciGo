// ============================================================
// TriciGo — Driver approved email template
//
// Sent by trg_send_driver_status_email (DB trigger on
// `driver_profiles` AFTER UPDATE status) when status='approved'.
//
// Before this template existed the trigger posted
// `template: 'driver_approved'` which fell through to the legacy
// "template-as-HTML-string" path, so the driver got an email whose
// body was the literal word "driver_approved". This template fixes it.
//
// data: { full_name, reason }  (reason unused for approvals)
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml } from './_layout.ts';

export interface DriverApprovedData {
  full_name: string;
  reason?: string;
}

export const driverApprovedSubject = '¡Tu cuenta TriciGo Conductor fue aprobada!';

export function driverApprovedHtml(data: DriverApprovedData): string {
  const name = data.full_name?.trim() || 'conductor';

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      ¡Felicitaciones, <strong>${escapeHtml(name)}</strong>!
    </p>
    <p style="margin: 0 0 16px;">
      Tu cuenta de conductor en TriciGo fue <strong style="color: ${COLORS.success};">aprobada</strong>.
      Ya puedes conectarte y empezar a recibir viajes.
    </p>
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 15px; font-weight: 600; color: ${COLORS.ink};">
      Para empezar:
    </p>
    <ol style="margin: 0 0 8px; padding-left: 20px; color: ${COLORS.text}; line-height: 1.6;">
      <li style="margin: 0 0 6px;">Abre la app TriciGo Conductor.</li>
      <li style="margin: 0 0 6px;">Activa tu disponibilidad para ponerte en línea.</li>
      <li style="margin: 0 0 6px;">Acepta tu primer viaje cuando recibas una solicitud.</li>
    </ol>
  `;

  return wrapHtml({
    preheader: '¡Tu cuenta de conductor fue aprobada! Ya puedes conectarte.',
    hero: {
      title: '¡Cuenta aprobada!',
      subtitle: 'Ya puedes conectarte y recibir viajes.',
    },
    body,
    footerNote:
      '¿Dudas para arrancar? Escríbenos a soporte@tricigo.com.',
  });
}
