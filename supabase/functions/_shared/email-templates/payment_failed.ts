// ============================================================
// TriciGo — Payment failed email template
//
// Sent by trg_send_payment_failed_email (DB trigger on
// `payment_intents` AFTER UPDATE status='failed'). Tells the user
// we couldn't process their payment and to retry from the app.
//
// Before this template existed the trigger posted
// `template: 'payment_failed'` which fell through to the legacy
// "template-as-HTML-string" path, so the user got an email whose
// body was the literal word "payment_failed". This template fixes it.
//
// data: { full_name, amount_cup, reason }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow } from './_layout.ts';

export interface PaymentFailedData {
  full_name: string;
  /** Intent amount (integer). */
  amount_cup: number;
  /** Optional provider reason (may be empty). */
  reason: string;
}

export const paymentFailedSubject = 'No pudimos procesar tu pago — TriciGo';

export function paymentFailedHtml(data: PaymentFailedData): string {
  const name = data.full_name?.trim() || 'Hola';
  const reason = data.reason?.trim();

  const detailRows = [
    data.amount_cup > 0 ? detailRow('Monto', fmtCup(data.amount_cup), { strong: true }) : '',
    reason ? detailRow('Motivo', reason, { muted: true }) : '',
  ].filter(Boolean).join('\n');

  const detailTable = detailRows
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">${detailRows}</table>`
    : '';

  const body = `
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(name)}</strong>.
    </p>
    <p style="margin: 0 0 20px;">
      No pudimos procesar tu pago. No te preocupes: no se realizó ningún cargo.
      Podés volver a intentarlo desde la app en unos minutos.
    </p>
    ${detailTable}
    <p style="margin: 20px 0 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.6;">
      Si el problema continúa, verificá los datos de tu tarjeta o probá con otro
      método de pago.
    </p>
  `;

  return wrapHtml({
    preheader: 'No pudimos procesar tu pago — podés reintentar desde la app.',
    hero: {
      title: 'Pago no procesado',
      subtitle: 'No se realizó ningún cargo. Podés reintentar.',
    },
    body,
    footerNote:
      '¿Necesitás ayuda con tu pago? Escribinos a soporte@tricigo.com.',
  });
}

// ── Helpers (local so the template stays self-contained) ─────────

function fmtCup(n: number): string {
  return `${Math.round(n).toLocaleString('es')} CUP`;
}
