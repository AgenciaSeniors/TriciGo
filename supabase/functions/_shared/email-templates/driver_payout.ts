// ============================================================
// TriciGo — Wallet credit / payout email template
//
// Shared by two DB triggers (both pass their own subject override):
//   - send_driver_payout_email() on wallet_transfers — for NON-gift
//     credits to a driver/super_admin wallet (subject
//     "Pago recibido — TriciGo"). Gifts get gift_received instead.
//   - send_cargo_bonus_email_from_ledger() on ledger_transactions —
//     the +5% courier bonus (subject "Bonus cargo recibido").
//
// Before this template existed both triggers posted
// `template: 'driver_payout'` which fell through to the legacy
// "template-as-HTML-string" path, so recipients got an email whose
// body was the literal word "driver_payout". This template (key
// 'driver_payout') fixes it.
//
// Amounts are integer TriciCoin (1 TC = 1 CUP). The `description`
// carries the reason (gift note, bonus explanation, etc.).
// data: { full_name, amount_cup, description, created_at, new_balance_cup }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, totalRow } from './_layout.ts';

export interface DriverPayoutData {
  full_name: string;
  /** Credited amount in TriciCoin (integer; 1 TC = 1 CUP). */
  amount_cup: number;
  /** Free-text reason for the credit (may be empty). */
  description: string;
  /** ISO timestamp. */
  created_at: string;
  /** Wallet balance after the credit (integer TriciCoin). */
  new_balance_cup: number;
}

export const driverPayoutSubject = 'Pago recibido — TriciGo';

export function driverPayoutHtml(data: DriverPayoutData): string {
  const name = data.full_name?.trim() || 'Hola';
  const description = data.description?.trim();
  const dateLabel = formatPayoutDate(data.created_at);

  const descriptionRow = description
    ? detailRow('Concepto', description)
    : '';

  const body = `
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Hola, <strong>${escapeHtml(name)}</strong>. Recibiste un pago en tu wallet TriciGo.
    </p>
    <p style="margin: 0 0 24px;">
      Ya está disponible en tus créditos TriciCoin.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">
      ${totalRow('Monto acreditado', fmtTrc(data.amount_cup))}
      ${descriptionRow}
      ${detailRow('Saldo disponible', fmtTrc(data.new_balance_cup), { strong: true })}
      ${detailRow('Fecha', dateLabel, { muted: true })}
    </table>
  `;

  return wrapHtml({
    preheader: `Pago recibido · ${fmtTrc(data.amount_cup)}`,
    hero: {
      title: 'Pago recibido',
      subtitle: `${fmtTrc(data.amount_cup)} acreditados en tu wallet.`,
    },
    body,
    footerNote:
      '¿Algo no cuadra? Escribinos a soporte@tricigo.com.',
  });
}

// ── Helpers (local so the template stays self-contained) ─────────

function fmtTrc(n: number): string {
  return `${Math.round(n).toLocaleString('es')} TriciCoin`;
}

function formatPayoutDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es', {
      day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Havana',
    });
  } catch {
    return iso;
  }
}
