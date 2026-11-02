// ============================================================
// TriciGo — writing to people whose ride found no driver (00674)
//
// The panel lists them (/missed-rides, admin_missed_riders) and operators write to each by
// WhatsApp. ops_contact_missed_rider records the contact and returns the apology coupon the
// person now holds, if any; this builds the message. The link is waMeLink (driverOutreach.ts).
// ============================================================

import { formatCUP } from './currency';
import { cubaTimeZone } from './date';

export interface ApologyCoupon {
  type: string;
  discountPercent: number | null;
  discountFixedCup: number | null;
  validUntil: string | null;
}

export interface MissedRideMessageInput {
  fullName: string | null | undefined;
  /** When the request that found no driver was canceled (ISO). */
  failedAt: string;
  coupon: ApologyCoupon | null;
}

/** "28 de octubre", in Cuba's clock. */
export function cubaDayMonth(iso: string): string {
  return new Intl.DateTimeFormat('es', { timeZone: cubaTimeZone(iso), day: 'numeric', month: 'long' }).format(
    new Date(iso),
  );
}

/** "500 CUP" or "un 25 %"; null when the coupon gives nothing. */
export function apologyDiscountText(coupon: ApologyCoupon): string | null {
  if (coupon.type === 'fixed_discount') {
    return coupon.discountFixedCup && coupon.discountFixedCup > 0 ? formatCUP(coupon.discountFixedCup) : null;
  }
  return coupon.discountPercent && coupon.discountPercent > 0 ? `un ${coupon.discountPercent} %` : null;
}

/** The WhatsApp message for someone whose request found no driver. */
export function missedRideApologyMessage({ fullName, failedAt, coupon }: MissedRideMessageInput): string {
  const firstName = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  const parts = [
    firstName ? `Hola, ${firstName}. Te escribimos de TriciGo.` : 'Hola. Te escribimos de TriciGo.',
    `El ${cubaDayMonth(failedAt)} pediste un viaje y no conseguimos conductor. Lo sentimos mucho.`,
  ];
  const discount = coupon ? apologyDiscountText(coupon) : null;
  if (coupon && discount) {
    parts.push(
      `Te dejamos ${discount} de descuento en tu próximo viaje. Ya está cargado en tu cuenta, no tienes que escribir ningún código.`,
    );
    if (coupon.validUntil) parts.push(`Vale hasta el ${cubaDayMonth(coupon.validUntil)}.`);
  } else {
    parts.push('Esperamos verte pronto en TriciGo.');
  }
  return parts.join(' ');
}
