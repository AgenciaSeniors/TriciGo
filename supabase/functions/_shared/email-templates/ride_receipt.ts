// ============================================================
// TriciGo — Ride receipt email template
//
// Sent by trg_send_ride_receipt (DB trigger on `rides` AFTER UPDATE
// status='completed'). The payload comes from the trigger function
// in 00134_ride_receipt_and_payment_notif_triggers.sql.
//
// Before this template existed, the trigger called send-email with
// `template: 'ride_receipt'` which fell through to the legacy
// "template-as-HTML-string" path — the rider received an email
// whose body was literally the word "ride_receipt". This template
// fixes that across every ride completed in prod.
//
// All numeric fields arrive as integers (CUP cents are not used —
// the wallet model stores whole CUP). Service type is a slug
// ('triciclo_basico' etc); we humanize it for display.
// ============================================================

import { wrapHtml, COLORS, FONT_STACK, escapeHtml, detailRow, totalRow } from './_layout.ts';

export interface RideReceiptData {
  /** ISO timestamps; we format only `completed_at` for display. */
  completed_at: string;
  created_at: string;
  pickup_address: string;
  dropoff_address: string;
  driver_name: string;
  service_type: string;
  payment_method: string;
  distance_km: number;
  duration_minutes: number;
  /** Fare breakdown in CUP (integers). */
  base_fare: number;
  distance_charge: number;
  time_charge: number;
  surge_multiplier: number;
  discount_amount: number;
  final_fare: number;
  estimated_fare: number | null;
}

export const rideReceiptSubject = 'Tu recibo de viaje TriciGo';

export function rideReceiptHtml(data: RideReceiptData): string {
  const completedDate = formatRideDate(data.completed_at);
  const serviceLabel = humanizeService(data.service_type);
  const paymentLabel = humanizePayment(data.payment_method);
  const surgeApplied = data.surge_multiplier > 1.001;
  const discountApplied = data.discount_amount > 0;

  // Fare breakdown — only show non-zero rows so short rides don't
  // get a wall of "0 CUP" lines.
  const breakdownRows: string[] = [];
  if (data.base_fare > 0) {
    breakdownRows.push(detailRow('Tarifa base', fmtCup(data.base_fare)));
  }
  if (data.distance_charge > 0) {
    breakdownRows.push(detailRow(`Distancia (${data.distance_km.toFixed(1)} km)`, fmtCup(data.distance_charge)));
  }
  if (data.time_charge > 0) {
    breakdownRows.push(detailRow(`Tiempo (${data.duration_minutes.toFixed(0)} min)`, fmtCup(data.time_charge)));
  }
  if (surgeApplied) {
    breakdownRows.push(
      detailRow('Mal tiempo', `×${data.surge_multiplier.toFixed(2)}`, { muted: true }),
    );
  }
  if (discountApplied) {
    breakdownRows.push(
      detailRow('Descuento aplicado', `−${fmtCup(data.discount_amount)}`, { muted: true }),
    );
  }

  const body = `
    <p style="margin: 0 0 8px; font-family: ${FONT_STACK}; font-size: 16px; color: ${COLORS.ink};">
      Gracias por viajar con <strong>TriciGo</strong>.
    </p>
    <p style="margin: 0 0 24px;">
      ${escapeHtml(completedDate)} · ${escapeHtml(serviceLabel)}
      ${data.driver_name ? ` · Conductor <strong style="color: ${COLORS.ink};">${escapeHtml(data.driver_name)}</strong>` : ''}
    </p>

    ${tripRouteBlock(data.pickup_address, data.dropoff_address)}

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 24px 0 8px;">
      ${breakdownRows.join('\n')}
      ${totalRow('Total', fmtCup(data.final_fare))}
    </table>

    <p style="margin: 16px 0 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted};">
      Método de pago: <strong style="color: ${COLORS.text};">${escapeHtml(paymentLabel)}</strong>
    </p>
  `;

  return wrapHtml({
    preheader: `Viaje completado · ${fmtCup(data.final_fare)}`,
    hero: {
      title: '¡Viaje completado!',
      subtitle: `Total cobrado: ${fmtCup(data.final_fare)}`,
    },
    body,
    footerNote:
      '¿Algo no cuadra con tu viaje? Respondé a este correo o escribinos a soporte@tricigo.com.',
  });
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Two-line trip route. Inline SVG-ish bullets so it renders without
 * needing extra image assets. The vertical rule connecting the two
 * dots is a 1px border on the inner cell.
 */
function tripRouteBlock(pickup: string, dropoff: string): string {
  const dotPickup = `<span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${COLORS.success}; vertical-align: middle;"></span>`;
  const dotDropoff = `<span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${COLORS.primary}; vertical-align: middle;"></span>`;
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: ${COLORS.bgPage}; border-radius: 10px; padding: 16px;">
      <tr>
        <td style="padding: 4px 12px 4px 0; font-family: ${FONT_STACK}; font-size: 13px; color: ${COLORS.muted}; vertical-align: top;">
          ${dotPickup}
        </td>
        <td style="padding: 4px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.4;">
          ${escapeHtml(pickup)}
        </td>
      </tr>
      <tr>
        <td style="padding: 4px 12px 4px 0; vertical-align: top;">
          ${dotDropoff}
        </td>
        <td style="padding: 4px 0; font-family: ${FONT_STACK}; font-size: 14px; color: ${COLORS.text}; line-height: 1.4;">
          ${escapeHtml(dropoff)}
        </td>
      </tr>
    </table>`;
}

function formatRideDate(iso: string): string {
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

const SERVICE_LABELS: Record<string, string> = {
  triciclo_basico: 'Triciclo',
  triciclo_premium: 'Triciclo Premium',
  triciclo_cargo: 'Triciclo Cargo',
  moto_standard: 'Moto',
  auto_standard: 'Auto',
  auto_confort: 'Confort',
  mensajeria: 'Mensajería',
};

function humanizeService(slug: string): string {
  return SERVICE_LABELS[slug] ?? slug;
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  tricicoin: 'Créditos TriciCoin',
  mixed: 'Mixto (créditos TriciCoin + efectivo)',
  stripe: 'Tarjeta',
  corporate: 'Cuenta corporativa',
  tropipay: 'Tarjeta',
};

function humanizePayment(slug: string): string {
  return PAYMENT_LABELS[slug] ?? slug;
}

function fmtCup(n: number): string {
  return `${Math.round(n).toLocaleString('es-CU')} CUP`;
}
