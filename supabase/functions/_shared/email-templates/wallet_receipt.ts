// ============================================================
// TriciGo — Wallet recharge receipt email template
//
// Sent by generate-recharge-receipt edge function (Resend direct,
// not via send-email, because attachments are needed). Provides
// the user with a confirmation that their USD recharge succeeded
// and how many TriciCoin landed in their wallet. The PDF receipt
// is attached separately by the caller.
//
// Same data shape used for both rider-facing and admin-facing
// variants — pass `audience: 'admin'` to render the internal-ops
// version with extra context (Stripe PI id, exchange rate).
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, totalRow } from './_layout.ts';

export interface WalletReceiptData {
  audience: 'user' | 'admin';
  receiptNo: string;        // e.g. "TG-20260511-001"
  dateLabel: string;        // pre-formatted, locale-aware ("11 de mayo de 2026, 14:30 (Cuba)")
  user: {
    full_name: string | null;
    email: string | null;
    id: string;
  };
  amounts: {
    usdCharged: number;
    feeUsd: number;
    netUsd: number;
    tcCredited: number;
    exchangeRate: number;
    cupEquivalent: number;
  };
  /** Only used in admin variant */
  stripePaymentIntentId?: string | null;
}

export const walletReceiptSubject = (receiptNo: string, audience: 'user' | 'admin') =>
  audience === 'admin'
    ? `[TriciGo] Recarga procesada · ${receiptNo}`
    : `Tu comprobante TriciGo · ${receiptNo}`;

export function walletReceiptHtml(data: WalletReceiptData): string {
  return data.audience === 'admin' ? renderAdmin(data) : renderUser(data);
}

// ── User-facing (warm, branded) ──────────────────────────────────

function renderUser(data: WalletReceiptData): string {
  const { user, receiptNo, dateLabel, amounts } = data;
  const greetingName = user.full_name?.trim() || 'pasajero';

  const body = `
    <p style="margin: 0 0 20px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(greetingName)}</strong>. Recibimos tu pago.
    </p>
    <p style="margin: 0 0 24px;">
      Tu wallet ya tiene los TriciCoin disponibles para tus próximos viajes.
      Adjuntamos el comprobante en PDF — también lo encontrás en tu billetera
      dentro de la app.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">
      ${detailRow('Comprobante', receiptNo, { strong: true })}
      ${detailRow('Fecha', dateLabel, { muted: true })}
      ${detailRow('Importe cobrado', fmtUsd(amounts.usdCharged))}
      ${detailRow('Comisión de servicio', `−${fmtUsd(amounts.feeUsd)}`, { muted: true })}
      ${detailRow('Importe acreditado', fmtUsd(amounts.netUsd), { strong: true })}
      ${totalRow('TriciCoin acreditados', fmtTrc(amounts.tcCredited))}
    </table>
    <p style="margin: 16px 0 0; font-family: ${FONT_STACK}; font-size: 12px; color: ${COLORS.muted}; line-height: 1.5;">
      Equivalente referencial: <strong style="color: ${COLORS.text};">${escapeHtml(fmtCup(amounts.cupEquivalent))}</strong>
      a la tasa del día (${amounts.exchangeRate.toFixed(2)} CUP/USD).
    </p>
  `;

  return wrapHtml({
    preheader: `Recarga confirmada · ${fmtTrc(amounts.tcCredited)} acreditados`,
    hero: {
      title: 'Recarga confirmada',
      subtitle: `${fmtTrc(amounts.tcCredited)} ya están en tu wallet.`,
    },
    body,
    footerNote:
      'Conservá este correo y el PDF adjunto como comprobante. Cualquier duda, escribinos a soporte@tricigo.com.',
  });
}

// ── Admin-facing (compact, ops-oriented) ─────────────────────────

function renderAdmin(data: WalletReceiptData): string {
  const { user, receiptNo, dateLabel, amounts, stripePaymentIntentId } = data;

  const body = `
    <p style="margin: 0 0 16px;">
      Notificación interna — recarga procesada y comprobante adjunto.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      ${detailRow('Comprobante', receiptNo, { strong: true })}
      ${detailRow('Usuario', `${user.full_name ?? '—'} <${user.email ?? '—'}>`)}
      ${detailRow('User ID', user.id, { muted: true })}
      ${detailRow('Fecha', dateLabel)}
      ${detailRow('USD cobrado', fmtUsd(amounts.usdCharged))}
      ${detailRow('Comisión', fmtUsd(amounts.feeUsd))}
      ${detailRow('Neto USD', fmtUsd(amounts.netUsd), { strong: true })}
      ${detailRow('TriciCoin acreditados', fmtTrc(amounts.tcCredited), { strong: true })}
      ${detailRow('Tasa USD/CUP', amounts.exchangeRate.toFixed(2))}
      ${detailRow('Equivalente CUP', fmtCup(amounts.cupEquivalent))}
      ${detailRow('Stripe PI', stripePaymentIntentId ?? '—', { muted: true })}
    </table>
  `;

  return wrapHtml({
    preheader: `[TriciGo ops] ${receiptNo} · ${user.full_name ?? user.email ?? user.id}`,
    body,
    footerBrand: 'TriciGo · Operaciones internas',
  });
}

// ── Format helpers (kept here so the template is self-contained) ──

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)} USD`;
}

function fmtTrc(n: number): string {
  return `${n.toFixed(2)} TriciCoin`;
}

function fmtCup(n: number): string {
  // CUP is integer-only in the wallet model. Round to integer and
  // group thousands with the cu-style narrow space.
  return `${Math.round(n).toLocaleString('es-CU')} CUP`;
}
