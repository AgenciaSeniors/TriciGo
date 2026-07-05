// ============================================================
// TriciGo — Delivery (cargo) receipt email template
//
// Sent by trg_send_delivery_receipt (DB trigger on `rides` AFTER
// UPDATE status='completed' AND ride_mode='cargo'). Confirms to the
// customer that their package was delivered, with proof (recipient,
// photo, OTP validation) and the fare.
//
// Before this template existed the trigger posted
// `template: 'delivery_receipt_customer'` which fell through to the
// legacy "template-as-HTML-string" path, so the customer got an
// email whose body was the literal word "delivery_receipt_customer".
// This template fixes it.
//
// All numeric fields are integer CUP.
// data: { completed_at, pickup_address, dropoff_address, driver_name,
//   recipient_name, package_category, delivery_photo_url,
//   delivery_otp_validated_at, final_fare }
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, totalRow, ctaButton } from './_layout.ts';

export interface DeliveryReceiptCustomerData {
  completed_at: string;
  pickup_address: string;
  dropoff_address: string;
  driver_name: string;
  recipient_name: string;
  package_category: string;
  delivery_photo_url?: string | null;
  delivery_otp_validated_at?: string | null;
  final_fare: number;
}

export const deliveryReceiptCustomerSubject = 'Tu envío llegó — recibo TriciGo';

export function deliveryReceiptCustomerHtml(data: DeliveryReceiptCustomerData): string {
  const completedLabel = formatDeliveryDate(data.completed_at);
  const otpValidated = !!(data.delivery_otp_validated_at && String(data.delivery_otp_validated_at).trim());

  const proofRows = [
    data.recipient_name?.trim()
      ? detailRow('Recibido por', data.recipient_name.trim(), { strong: true })
      : '',
    data.package_category?.trim()
      ? detailRow('Tipo de paquete', humanizeCategory(data.package_category))
      : '',
    otpValidated
      ? detailRow('Entrega confirmada', 'Sí · código validado', { muted: true })
      : '',
    data.driver_name?.trim()
      ? detailRow('Conductor', data.driver_name.trim(), { muted: true })
      : '',
    detailRow('Fecha', completedLabel, { muted: true }),
  ].filter(Boolean).join('\n');

  const photoBlock = data.delivery_photo_url && String(data.delivery_photo_url).trim()
    ? `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 16px auto 0;">
      <tr>
        <td align="center">
          ${ctaButton('Ver foto de entrega', String(data.delivery_photo_url))}
        </td>
      </tr>
    </table>`
    : '';

  const body = `
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Tu envío fue <strong style="color: ${COLORS.success};">entregado</strong>.
    </p>
    <p style="margin: 0 0 24px;">
      Gracias por enviar con <strong>TriciGo</strong>. Acá está el comprobante.
    </p>

    ${routeBlock(data.pickup_address, data.dropoff_address)}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0 8px;">
      ${proofRows}
      ${totalRow('Total', fmtCup(data.final_fare))}
    </table>
    ${photoBlock}
  `;

  return wrapHtml({
    preheader: `Envío entregado · ${fmtCup(data.final_fare)}`,
    hero: {
      title: '¡Tu envío llegó!',
      subtitle: `Entregado · Total ${fmtCup(data.final_fare)}`,
    },
    body,
    footerNote:
      '¿Algo no cuadra con tu envío? Escribinos a soporte@tricigo.com.',
  });
}

// ── Helpers (local so the template stays self-contained) ─────────

function routeBlock(pickup: string, dropoff: string): string {
  const dotPickup = `<span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${COLORS.success}; vertical-align: middle;"></span>`;
  const dotDropoff = `<span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${COLORS.primary}; vertical-align: middle;"></span>`;
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: ${COLORS.bgPage}; border-radius: 10px; padding: 16px;">
      <tr>
        <td style="padding: 4px 12px 4px 0; vertical-align: top;">${dotPickup}</td>
        <td style="padding: 4px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.4;">
          ${escapeHtml(pickup)}
        </td>
      </tr>
      <tr>
        <td style="padding: 4px 12px 4px 0; vertical-align: top;">${dotDropoff}</td>
        <td style="padding: 4px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.4;">
          ${escapeHtml(dropoff)}
        </td>
      </tr>
    </table>`;
}

const CATEGORY_LABELS: Record<string, string> = {
  documents: 'Documentos',
  food: 'Comida',
  electronics: 'Electrónica',
  clothing: 'Ropa',
  medicine: 'Medicamentos',
  fragile: 'Frágil',
  other: 'Otro',
};

function humanizeCategory(slug: string): string {
  return CATEGORY_LABELS[slug] ?? slug;
}

function formatDeliveryDate(iso: string): string {
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

function fmtCup(n: number): string {
  return `${Math.round(n).toLocaleString('es')} CUP`;
}
