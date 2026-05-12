// ============================================================
// TriciGo — Driver under review email template
//
// Sent by trg_send_driver_under_review (00138_notify_driver_under_
// review.sql) to the configured business email when a new driver
// submits onboarding for verification. Audience is internal ops —
// admin clicks through to the driver's record in the admin panel.
//
// Before this template existed the trigger called send-email with
// `template: 'driver_under_review'` which fell through to the
// legacy HTML-string path. So every onboarding submission was
// silently sending an "email" whose body was the literal string
// "driver_under_review" to the ops mailbox. This template fixes it.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, WEB_ORIGIN } from './_layout.ts';

export interface DriverUnderReviewData {
  driver_id: string;
  user_id: string;
  full_name: string;
  phone: string;
  email: string;
  /** ISO timestamp from the trigger. */
  submitted_at: string;
}

export const driverUnderReviewSubject = 'Nuevo conductor pendiente de aprobación — TriciGo';

export function driverUnderReviewHtml(data: DriverUnderReviewData): string {
  const submittedLabel = formatSubmittedAt(data.submitted_at);
  // Admin panel route — best effort. If the admin URL changes, override
  // via env or update the link target.
  const reviewHref = `${WEB_ORIGIN.replace('https://', 'https://admin.')}/drivers/${encodeURIComponent(data.driver_id)}`;

  const body = `
    <p style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hay un <strong>nuevo conductor</strong> esperando revisión.
    </p>
    <p style="margin: 0 0 24px;">
      Datos enviados desde la app driver. Confirmá identidad, vehículo y
      documentos en el panel.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${detailRow('Nombre', data.full_name || '—', { strong: true })}
      ${detailRow('Teléfono', data.phone || '—')}
      ${detailRow('Email', data.email || '—')}
      ${detailRow('Driver ID', data.driver_id, { muted: true })}
      ${detailRow('User ID', data.user_id, { muted: true })}
      ${detailRow('Enviado', submittedLabel, { muted: true })}
    </table>
  `;

  return wrapHtml({
    preheader: `[TriciGo ops] Conductor pendiente · ${data.full_name || data.driver_id}`,
    hero: {
      title: 'Conductor pendiente de aprobación',
      subtitle: 'Nuevo onboarding listo para revisión.',
    },
    body,
    cta: { label: 'Abrir en admin', href: reviewHref },
    footerBrand: 'TriciGo · Operaciones internas',
  });
}

function formatSubmittedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-CU', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Havana',
    });
  } catch {
    return iso;
  }
}

// Re-export so the `WEB_ORIGIN` import is recognized by Deno's
// import-map even when no other helper is consumed elsewhere.
export const _DEPS = { WEB_ORIGIN, escapeHtml, FONT_STACK, COLORS };
