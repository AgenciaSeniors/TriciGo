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
import { realEmail } from '../email-guard.ts';

export interface WalletReceiptData {
  audience: 'user' | 'admin';
  receiptNo: string;        // e.g. "TG-20260511-001"
  dateLabel: string;        // pre-formatted, locale-aware ("11 de mayo de 2026, 14:30 (Cuba)")
  user: {
    full_name: string | null;
    email: string | null;
    id: string;
  };
  /**
   * RECARGA V2 amounts (additive fee model).
   *   - usdRequested:  the net USD the user picked (e.g. $20).
   *   - feeUsd:        the additive service fee (3% min $0.50).
   *   - usdCharged:    what hit the card (= usdRequested + feeUsd).
   *   - tcCredited:    TriciCoin (= CUP) deposited in the wallet.
   *   - exchangeRate:  the USD→CUP snapshot at intent creation time.
   */
  amounts: {
    usdRequested: number;
    feeUsd: number;
    usdCharged: number;
    tcCredited: number;
    exchangeRate: number;
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
      Tus créditos TriciCoin ya están disponibles para tus próximos viajes.
      Adjuntamos el comprobante en PDF — también lo encontrás en tus créditos
      de viaje dentro de la app.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">
      ${detailRow('Comprobante', receiptNo, { strong: true })}
      ${detailRow('Fecha', dateLabel, { muted: true })}
      ${detailRow('Recarga solicitada', fmtUsd(amounts.usdRequested))}
      ${detailRow('Comisión de servicio (3%)', fmtUsd(amounts.feeUsd), { muted: true })}
      ${detailRow('Cargo total a tu tarjeta', fmtUsd(amounts.usdCharged), { strong: true })}
      ${totalRow('TriciCoin acreditados', fmtTrc(amounts.tcCredited))}
    </table>
    <p style="margin: 16px 0 0; font-family: ${FONT_STACK}; font-size: 12px; color: ${COLORS.muted}; line-height: 1.5;">
      Equivalente referencial en CUP:
      <strong style="color: ${COLORS.text};">${escapeHtml(fmtCup(amounts.tcCredited))}</strong>
      a la tasa del día (${amounts.exchangeRate.toFixed(2)} CUP/USD).
    </p>
  `;

  return wrapHtml({
    preheader: `Recarga confirmada · ${fmtTrc(amounts.tcCredited)} acreditados`,
    hero: {
      title: 'Recarga confirmada',
      subtitle: `${fmtTrc(amounts.tcCredited)} ya están en tus créditos.`,
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
      ${detailRow('Usuario', `${user.full_name?.trim() || '—'} <${realEmail(user.email) ?? '—'}>`)}
      ${detailRow('User ID', user.id, { muted: true })}
      ${detailRow('Fecha', dateLabel)}
      ${detailRow('Recarga solicitada (neto)', fmtUsd(amounts.usdRequested), { strong: true })}
      ${detailRow('Comisión de servicio', fmtUsd(amounts.feeUsd))}
      ${detailRow('Cargo total a la tarjeta', fmtUsd(amounts.usdCharged), { strong: true })}
      ${detailRow('TriciCoin acreditados', fmtTrc(amounts.tcCredited), { strong: true })}
      ${detailRow('Tasa USD/CUP', amounts.exchangeRate.toFixed(2))}
      ${detailRow('Equivalente CUP (referencial)', fmtCup(amounts.tcCredited))}
      ${detailRow('Provider txn id', stripePaymentIntentId ?? '—', { muted: true })}
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
  // RECARGA V2: 1 TC = 1 CUP integer. Format with thousands separator and
  // no decimals so a 10500-TC recharge reads "10.500 TriciCoin".
  return `${Math.round(n).toLocaleString('es-CU')} TriciCoin`;
}

function fmtCup(n: number): string {
  // CUP is integer-only in the wallet model. Round to integer and
  // group thousands with the cu-style narrow space.
  return `${Math.round(n).toLocaleString('es-CU')} CUP`;
}
