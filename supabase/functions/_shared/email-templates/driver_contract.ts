// ============================================================
// TriciGo — Driver T&C-acceptance contract email template
//
// Sent by the generate-driver-contract EF (Resend direct, with the
// contract PDF(s) attached) when a driver completes onboarding:
//   - audience 'driver': Spanish body + the Spanish contract PDF.
//   - audience 'admin':  ops-oriented body + BOTH PDFs attached
//     (Spanish and Romanian — the operating company is Romanian).
//
// Imported directly (not via the registry index) so the EF deploy
// bundle stays narrow, mirroring generate-recharge-receipt.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, WEB_ORIGIN } from './_layout.ts';

export interface DriverContractEmailData {
  audience: 'driver' | 'admin';
  contractNo: string;
  driverName: string;
  driverPhone: string | null;
  driverEmail: string | null;
  /** Already-formatted Havana-time label. */
  acceptedLabel: string;
  /** driver_profiles.id — for the admin deep link. */
  driverId: string;
}

export function driverContractSubject(audience: 'driver' | 'admin', contractNo: string): string {
  return audience === 'driver'
    ? `Tu contrato con TriciGo — ${contractNo}`
    : `Contrato de conductor generado — ${contractNo} (ES + RO)`;
}

export function driverContractHtml(data: DriverContractEmailData): string {
  return data.audience === 'driver' ? renderDriver(data) : renderAdmin(data);
}

function renderDriver(data: DriverContractEmailData): string {
  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola${data.driverName ? ` <strong>${escapeHtml(data.driverName)}</strong>` : ''},
    </p>
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      ¡Gracias por registrarte como conductor en TriciGo! Te adjuntamos tu
      <strong>contrato de aceptación de los Términos y Condiciones</strong> en PDF.
      Incluye el texto completo de los términos que aceptaste al completar tu registro.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${detailRow('Nº de contrato', data.contractNo, { strong: true })}
      ${detailRow('Fecha de aceptación', data.acceptedLabel)}
    </table>
    <p style="margin: 24px 0 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted}; line-height: 1.6;">
      Guardá este documento para tu referencia. Tu solicitud está siendo revisada por
      nuestro equipo — te avisaremos cuando tu cuenta sea aprobada.
    </p>
  `;

  return wrapHtml({
    preheader: `Tu contrato con TriciGo · ${data.contractNo}`,
    hero: {
      title: 'Tu contrato con TriciGo',
      subtitle: 'Aceptación de Términos y Condiciones — conductor',
    },
    body,
    footerNote: 'Si no fuiste vos quien se registró como conductor, escribinos a soporte@tricigo.com.',
  });
}

function renderAdmin(data: DriverContractEmailData): string {
  const reviewHref = `${WEB_ORIGIN.replace('https://', 'https://admin.')}/drivers/${encodeURIComponent(data.driverId)}`;

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Se generó el <strong>contrato de aceptación de T&amp;C</strong> de un conductor nuevo.
    </p>
    <p style="margin: 0 0 24px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      Se adjuntan las versiones en <strong>español</strong> y <strong>rumano</strong>.
      Ambas quedan también archivadas y descargables desde el perfil del conductor en el panel admin.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${detailRow('Conductor', data.driverName || '—', { strong: true })}
      ${detailRow('Teléfono', data.driverPhone || '—')}
      ${detailRow('Email', data.driverEmail || '—')}
      ${detailRow('Nº de contrato', data.contractNo)}
      ${detailRow('Aceptado', data.acceptedLabel, { muted: true })}
      ${detailRow('Driver ID', data.driverId, { muted: true })}
    </table>
  `;

  return wrapHtml({
    preheader: `[TriciGo ops] Contrato ${data.contractNo} · ${data.driverName || data.driverId}`,
    hero: {
      title: 'Contrato de conductor generado',
      subtitle: 'Aceptación de Términos y Condiciones (ES + RO adjuntos)',
    },
    body,
    cta: { label: 'Abrir en admin', href: reviewHref },
    footerBrand: 'TriciGo · Operaciones internas',
  });
}
