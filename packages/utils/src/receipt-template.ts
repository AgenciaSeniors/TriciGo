// ============================================================
// Ride receipt PDF template — passenger + driver variants.
// ============================================================
// Renders a single-page HTML payload that expo-print converts
// to PDF. Two variants share the same shell but diverge on the
// pricing breakdown and on whose name is highlighted.
//
// The receipt number is deterministic from the ride.id so the
// same ride always produces the same TR-YYYY-XXXXXXXX label —
// no DB sequence required at this layer. (When/if Cuban audit
// rules require strictly-sequential numbering, swap this for
// a `rides.receipt_no text UNIQUE` column populated by trigger.)
// ============================================================

export interface BaseReceiptData {
  /** Format: 'TR-2026-A1B2C3D4' — see deriveReceiptNo() */
  receiptNo: string;
  rideId: string;
  /** ISO timestamp — usually completed_at, falls back to created_at. */
  date: string;
  pickupAddress: string;
  dropoffAddress: string;
  serviceType: string;
  distanceM: number;
  durationS: number;
  /** 'cash' | 'tricicoin' | 'corporate' | 'mixed' (or already-localised) */
  paymentMethod: string;
  /** USD/CUP rate snapshot at ride completion. Null when unavailable. */
  exchangeRateUsdCup: number | null;
}

export interface PassengerReceiptData extends BaseReceiptData {
  variant: 'passenger';
  driverName: string | null;
  vehiclePlate: string | null;
  /** Pre-surge, pre-discount subtotal (= base + per-km*km + per-min*min). */
  subtotalCup: number;
  /** Surge multiplier; > 1 when surge applied. */
  surgeMultiplier: number;
  /** Computed: subtotal * (surgeMultiplier - 1). */
  surgeAmountCup: number;
  discountCup: number;
  tipCup: number;
  /** Final amount the passenger paid. */
  totalCup: number;
  /** Amount paid in TriciCoin (when payment_method involves the wallet). */
  fareTrc: number | null;
}

export interface DriverReceiptData extends BaseReceiptData {
  variant: 'driver';
  passengerName: string | null;
  /** Total fare collected (gross, before commission). */
  grossFareCup: number;
  /** Platform commission rate (e.g. 0.15 for 15%). */
  commissionRate: number;
  /** commissionRate * grossFareCup, rounded to whole CUP. */
  commissionCup: number;
  /** Tip — passes through 100% to the driver. */
  tipCup: number;
  /** gross - commission + tip. */
  netCup: number;
}

export type ReceiptData = PassengerReceiptData | DriverReceiptData;

/**
 * Build a stable, formal-looking receipt number from the ride id and
 * its completion date. Deterministic: same input always yields the
 * same output, so the number stays consistent if the receipt is
 * regenerated months later.
 */
export function deriveReceiptNo(rideId: string, dateISO: string): string {
  const year = new Date(dateISO).getFullYear();
  const hex = rideId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `TR-${year}-${hex}`;
}

type Locale = 'en' | 'es';

interface Labels {
  passengerTitle: string;
  driverTitle: string;
  date: string;
  service: string;
  driver: string;
  vehicle: string;
  passenger: string;
  pickup: string;
  dropoff: string;
  distance: string;
  duration: string;
  fareBreakdown: string;
  earningsBreakdown: string;
  subtotal: string;
  surge: string;
  discount: string;
  tip: string;
  totalCharged: string;
  grossFare: string;
  commission: string;
  netPay: string;
  payment: string;
  paymentLabel: string;
  exchangeRateInfo: string;
  oneUsdEquals: string;
  equivalent: string;
  rideRef: string;
  footer: string;
  tipDriverNote: string;
}

function getLabels(locale: Locale): Labels {
  if (locale === 'en') {
    return {
      passengerTitle: 'Ride Receipt',
      driverTitle: 'Earnings Receipt',
      date: 'Date',
      service: 'Service',
      driver: 'Driver',
      vehicle: 'Vehicle',
      passenger: 'Passenger',
      pickup: 'Pickup',
      dropoff: 'Dropoff',
      distance: 'Distance',
      duration: 'Duration',
      fareBreakdown: 'Fare breakdown',
      earningsBreakdown: 'Earnings breakdown',
      subtotal: 'Subtotal (base + distance + time)',
      surge: 'Surge',
      discount: 'Discount',
      tip: 'Tip',
      totalCharged: 'Total charged',
      grossFare: 'Gross fare',
      commission: 'Platform commission',
      netPay: 'Net pay',
      payment: 'Payment method',
      paymentLabel: 'Payment',
      exchangeRateInfo: 'Exchange rate (informational)',
      oneUsdEquals: '1 USD',
      equivalent: 'USD equivalent',
      rideRef: 'Ride ID',
      footer: 'Thank you for riding with TriciGo!',
      tipDriverNote: 'Tip — paid 100% to driver',
    };
  }
  return {
    passengerTitle: 'Comprobante de Viaje',
    driverTitle: 'Comprobante de Ingreso',
    date: 'Fecha',
    service: 'Servicio',
    driver: 'Conductor',
    vehicle: 'Vehículo',
    passenger: 'Pasajero',
    pickup: 'Origen',
    dropoff: 'Destino',
    distance: 'Distancia',
    duration: 'Duración',
    fareBreakdown: 'Detalle de la tarifa',
    earningsBreakdown: 'Desglose del ingreso',
    subtotal: 'Subtotal (base + recorrido + tiempo)',
    surge: 'Recargo por demanda',
    discount: 'Descuento',
    tip: 'Propina',
    totalCharged: 'Total cobrado',
    grossFare: 'Tarifa bruta',
    commission: 'Comisión TriciGo',
    netPay: 'Pago neto',
    payment: 'Método de pago',
    paymentLabel: 'Pago',
    exchangeRateInfo: 'Equivalencia (informativa)',
    oneUsdEquals: '1 USD',
    equivalent: 'Equivalente',
    rideRef: 'ID viaje',
    footer: '¡Gracias por viajar con TriciGo!',
    tipDriverNote: 'Propina — 100% para el conductor',
  };
}

const fmtCup = (cup: number): string =>
  new Intl.NumberFormat('es-CU', { maximumFractionDigits: 0 }).format(Math.round(cup)) + ' CUP';

const fmtUsd = (usd: number): string => '$' + usd.toFixed(2) + ' USD';

const fmtTrc = (trc: number): string =>
  new Intl.NumberFormat('es-CU', { maximumFractionDigits: 0 }).format(Math.round(trc)) + ' TC';

const fmtDate = (iso: string, locale: Locale): string =>
  new Date(iso).toLocaleDateString(locale === 'en' ? 'en-US' : 'es-CU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Havana',
  });

/**
 * Pretty-print a trip duration in seconds. PR H (2026-05-25):
 * receipts used to render `Math.round(durationS / 60) + ' min'`,
 * which produced "0 min" for any trip shorter than 30 s — confusing
 * the user (reported on-device: short test trip showed "0 min" on
 * the receipt). Short trips now read as "<1 min" or, when the
 * duration is missing/zero (e.g. legacy completed rides with
 * actual_duration_s = 0), as "—" so the receipt doesn't lie.
 */
function fmtDuration(durationS: number): string {
  if (!Number.isFinite(durationS) || durationS <= 0) return '—';
  if (durationS < 60) return '<1 min';
  return Math.round(durationS / 60).toString() + ' min';
}

function row(label: string, value: string, opts: { mute?: boolean; bold?: boolean; positive?: boolean; negative?: boolean } = {}): string {
  const labelColor = opts.mute ? '#888' : '#444';
  const valueColor = opts.negative ? '#22c55e' : opts.positive ? '#1a1a1a' : '#1a1a1a';
  const valueWeight = opts.bold ? '700' : '500';
  return `<tr style="border-bottom:1px solid #f0f0f0;">
    <td style="padding:8px 0;color:${labelColor};font-size:13px;">${label}</td>
    <td style="padding:8px 0;text-align:right;color:${valueColor};font-weight:${valueWeight};font-size:13px;">${value}</td>
  </tr>`;
}

function totalRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:14px 0 4px;color:#1a1a1a;font-size:14px;font-weight:700;border-top:2px solid #F97316;">${label}</td>
    <td style="padding:14px 0 4px;text-align:right;color:#F97316;font-size:22px;font-weight:800;border-top:2px solid #F97316;">${value}</td>
  </tr>`;
}

function shell(title: string, receiptNo: string, body: string, footer: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;background:#fff;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
    <div>
      <h1 style="color:#F97316;margin:0;font-size:30px;font-weight:800;letter-spacing:-0.02em;">TriciGo</h1>
      <p style="margin:6px 0 0;font-size:15px;font-weight:600;color:#1a1a1a;">${title}</p>
    </div>
    <div style="text-align:right;">
      <p style="margin:0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;">N°</p>
      <p style="margin:2px 0 0;font-size:13px;font-weight:700;color:#1a1a1a;font-family:monospace;">${receiptNo}</p>
    </div>
  </div>
  ${body}
  <p style="text-align:center;color:#888;font-size:11px;margin-top:28px;">${footer}</p>
  <p style="text-align:center;color:#bbb;font-size:9px;margin-top:4px;">TriciGo · Cuba · contacto@tricigo.com</p>
</body></html>`;
}

function passengerHtml(data: PassengerReceiptData, l: Labels, locale: Locale): string {
  const distKm = (data.distanceM / 1000).toFixed(1);
  const durStr = fmtDuration(data.durationS);
  const tipShown = data.tipCup > 0;
  const surgeShown = data.surgeMultiplier > 1 && data.surgeAmountCup > 0;
  const discountShown = data.discountCup > 0;
  const trcShown = data.fareTrc != null && data.fareTrc > 0;
  const fxShown = data.exchangeRateUsdCup != null && data.exchangeRateUsdCup > 0;
  const usdEq = fxShown ? data.totalCup / data.exchangeRateUsdCup! : null;

  const meta = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
    ${row(l.date, fmtDate(data.date, locale), { mute: true })}
    ${row(l.service, data.serviceType, { mute: true })}
    ${data.driverName ? row(l.driver, data.driverName, { mute: true }) : ''}
    ${data.vehiclePlate ? row(l.vehicle, data.vehiclePlate, { mute: true }) : ''}
    ${row(l.pickup, data.pickupAddress, { mute: true })}
    ${row(l.dropoff, data.dropoffAddress, { mute: true })}
    ${row(`${l.distance} · ${l.duration}`, `${distKm} km · ${durStr}`, { mute: true })}
  </table>`;

  const breakdown = `<h2 style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.05em;">${l.fareBreakdown}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
    ${row(l.subtotal, fmtCup(data.subtotalCup))}
    ${surgeShown ? row(`${l.surge} (${data.surgeMultiplier.toFixed(1)}x)`, fmtCup(data.surgeAmountCup)) : ''}
    ${discountShown ? row(l.discount, '-' + fmtCup(data.discountCup), { negative: true }) : ''}
    ${tipShown ? row(l.tip, fmtCup(data.tipCup)) : ''}
    ${totalRow(l.totalCharged, fmtCup(data.totalCup))}
  </table>`;

  const fx = fxShown ? `<div style="margin-top:14px;padding:10px 12px;background:#fafafa;border-radius:8px;font-size:11.5px;color:#666;">
    <p style="margin:0 0 3px;font-weight:600;color:#1a1a1a;">${l.exchangeRateInfo}</p>
    <p style="margin:0;">${l.oneUsdEquals} = ${fmtCup(data.exchangeRateUsdCup!)} (${fmtDate(data.date, locale).split(',')[0]})</p>
    ${usdEq != null ? `<p style="margin:2px 0 0;">${l.equivalent}: ${fmtUsd(usdEq)}</p>` : ''}
    ${trcShown ? `<p style="margin:2px 0 0;">TriciCoin: ${fmtTrc(data.fareTrc!)}</p>` : ''}
  </div>` : '';

  const payment = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px;">
    ${row(l.payment, data.paymentMethod)}
    ${row(l.rideRef, data.rideId, { mute: true })}
  </table>`;

  return shell(l.passengerTitle, data.receiptNo, meta + breakdown + fx + payment, l.footer);
}

function driverHtml(data: DriverReceiptData, l: Labels, locale: Locale): string {
  const distKm = (data.distanceM / 1000).toFixed(1);
  const durStr = fmtDuration(data.durationS);
  const tipShown = data.tipCup > 0;
  const fxShown = data.exchangeRateUsdCup != null && data.exchangeRateUsdCup > 0;
  const usdEq = fxShown ? data.netCup / data.exchangeRateUsdCup! : null;

  const meta = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
    ${row(l.date, fmtDate(data.date, locale), { mute: true })}
    ${row(l.service, data.serviceType, { mute: true })}
    ${data.passengerName ? row(l.passenger, data.passengerName, { mute: true }) : ''}
    ${row(l.pickup, data.pickupAddress, { mute: true })}
    ${row(l.dropoff, data.dropoffAddress, { mute: true })}
    ${row(`${l.distance} · ${l.duration}`, `${distKm} km · ${durStr}`, { mute: true })}
  </table>`;

  const commissionPct = (data.commissionRate * 100).toFixed(0);

  const breakdown = `<h2 style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.05em;">${l.earningsBreakdown}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;">
    ${row(l.grossFare, fmtCup(data.grossFareCup))}
    ${row(`${l.commission} (${commissionPct}%)`, '-' + fmtCup(data.commissionCup), { negative: true })}
    ${tipShown ? row(`${l.tip} — ${l.tipDriverNote}`, '+' + fmtCup(data.tipCup)) : ''}
    ${totalRow(l.netPay, fmtCup(data.netCup))}
  </table>`;

  const fx = fxShown ? `<div style="margin-top:14px;padding:10px 12px;background:#fafafa;border-radius:8px;font-size:11.5px;color:#666;">
    <p style="margin:0 0 3px;font-weight:600;color:#1a1a1a;">${l.exchangeRateInfo}</p>
    <p style="margin:0;">${l.oneUsdEquals} = ${fmtCup(data.exchangeRateUsdCup!)}</p>
    ${usdEq != null ? `<p style="margin:2px 0 0;">${l.netPay}: ${fmtUsd(usdEq)}</p>` : ''}
  </div>` : '';

  const payment = `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px;">
    ${row(l.paymentLabel, data.paymentMethod)}
    ${row(l.rideRef, data.rideId, { mute: true })}
  </table>`;

  return shell(l.driverTitle, data.receiptNo, meta + breakdown + fx + payment, l.footer);
}

export function generateReceiptHTML(data: ReceiptData, locale: Locale = 'es'): string {
  const labels = getLabels(locale);
  return data.variant === 'passenger'
    ? passengerHtml(data, labels, locale)
    : driverHtml(data, labels, locale);
}
