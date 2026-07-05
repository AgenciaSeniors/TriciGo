// ============================================================
// TriciGo — Gift received email template
//
// Sent by trg_send_driver_payout_email (DB trigger on
// `wallet_transfers` AFTER INSERT) when the row is a gift
// (kind='gift' and not a reversal). The closed-loop "Regalo"
// feature (send_gift RPC, migs 00343-00351) credits the
// recipient's wallet; this email tells them who sent it, how
// much, and the optional note.
//
// Before this template existed the trigger posted
// `template: 'driver_payout'` which fell through to the legacy
// "template-as-HTML-string" path, so the gift recipient got an
// email whose body was the literal word "driver_payout". This
// template (key 'gift_received') fixes it and gives gifts their
// own branded message instead of a generic "payment received".
//
// Amounts are integer TriciCoin (1 TC = 1 CUP).
// data: { full_name, amount_cup, from_name, note, created_at, new_balance_cup }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, totalRow } from './_layout.ts';

export interface GiftReceivedData {
  full_name: string;
  /** Gift amount in TriciCoin (integer; 1 TC = 1 CUP). */
  amount_cup: number;
  /** Sender's display name (may be empty). */
  from_name: string;
  /** Optional note the sender attached (may be empty). */
  note: string;
  /** ISO timestamp from the trigger. */
  created_at: string;
  /** Recipient's wallet balance after the gift (integer TriciCoin). */
  new_balance_cup: number;
}

export const giftReceivedSubject = '🎁 Recibiste un regalo en TriciGo';

export function giftReceivedHtml(data: GiftReceivedData): string {
  const name = data.full_name?.trim() || 'Hola';
  const sender = data.from_name?.trim();
  const note = data.note?.trim();
  const dateLabel = formatGiftDate(data.created_at);

  const intro = sender
    ? `<strong>${escapeHtml(sender)}</strong> te envió un regalo en TriciGo.`
    : 'Recibiste un regalo en TriciGo.';

  const noteBlock = note
    ? `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 8px 0 0; background: ${COLORS.bgPage}; border-radius: 10px;">
      <tr>
        <td style="padding: 14px 16px; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.5;">
          <span style="display: block; font-size: 12px; font-weight: 600; color: ${COLORS.muted}; margin: 0 0 4px;">Mensaje</span>
          “${escapeHtml(note)}”
        </td>
      </tr>
    </table>`
    : '';

  const body = `
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      ${escapeHtml(name)}, ${intro}
    </p>
    <p style="margin: 0 0 24px;">
      Ya está disponible en tus créditos TriciCoin para tus próximos viajes.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 8px;">
      ${totalRow('Regalo recibido', fmtTrc(data.amount_cup))}
      ${detailRow('Saldo disponible', fmtTrc(data.new_balance_cup), { strong: true })}
      ${detailRow('Fecha', dateLabel, { muted: true })}
    </table>
    ${noteBlock}
  `;

  return wrapHtml({
    preheader: `Recibiste un regalo · ${fmtTrc(data.amount_cup)}`,
    hero: {
      title: 'Recibiste un regalo 🎁',
      subtitle: `${fmtTrc(data.amount_cup)} en tus créditos TriciCoin.`,
    },
    body,
    footerNote:
      'Los regalos TriciGo se usan para pagar viajes dentro de la app. ¿Dudas? Escribinos a soporte@tricigo.com.',
  });
}

// ── Helpers (local so the template stays self-contained) ─────────

function fmtTrc(n: number): string {
  return `${Math.round(n).toLocaleString('es')} TriciCoin`;
}

function formatGiftDate(iso: string): string {
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
