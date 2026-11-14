export type MotoDeportivaStatusValue = 'hidden' | 'off' | 'offline' | 'busy' | 'available';
export interface MotoDeportivaStatus { status: MotoDeportivaStatusValue; waiting: boolean }
export interface MotoDeportivaCard {
  visible: boolean;
  requestable: boolean;
  reason: 'unavailable' | 'busy' | null;
  waitlist: 'none' | 'join' | 'joined';
}

const VALUES: readonly MotoDeportivaStatusValue[] = ['hidden', 'off', 'offline', 'busy', 'available'];
export const MOTO_DEPORTIVA_SLUG = 'moto_deportiva' as const;
/** After this many seconds searching, the rider is offered a regular moto. */
export const MOTO_FALLBACK_AFTER_S = 120;
/** platform_config key with the CUP added to the moto fare (−200 on 2026-11-09). */
export const MOTO_DEPORTIVA_OFFSET_KEY = 'moto_deportiva_price_offset_cup';
/** Offset used when the platform_config row cannot be read (migration not applied). */
export const MOTO_DEPORTIVA_DEFAULT_OFFSET_CUP = -200;

export function parseMotoDeportivaStatus(raw: unknown): MotoDeportivaStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { status?: unknown; waiting?: unknown };
  if (typeof r.status !== 'string' || !(VALUES as readonly string[]).includes(r.status)) return null;
  return { status: r.status as MotoDeportivaStatusValue, waiting: r.waiting === true };
}

export function motoDeportivaCard(s: MotoDeportivaStatus | null): MotoDeportivaCard {
  if (!s || s.status === 'hidden') return { visible: false, requestable: false, reason: null, waitlist: 'none' };
  if (s.status === 'available') return { visible: true, requestable: true, reason: null, waitlist: 'none' };
  if (s.status === 'busy') return { visible: true, requestable: false, reason: 'busy', waitlist: 'none' };
  return { visible: true, requestable: false, reason: 'unavailable', waitlist: s.waiting ? 'joined' : 'join' };
}

export function shouldOfferMotoFallback(p: { serviceType: string | null | undefined; status: string | null | undefined; elapsedSeconds: number }): boolean {
  return p.serviceType === MOTO_DEPORTIVA_SLUG && p.status === 'searching' && p.elapsedSeconds >= MOTO_FALLBACK_AFTER_S;
}

/** The Moto Deportiva fare: the moto fare plus the offset, never below its own minimum. */
export function applyMotoDeportivaOffset(motoFareCup: number, offsetCup: number, minFareCup: number): number {
  const offset = Number.isFinite(offsetCup) ? offsetCup : 0;
  return Math.max(Math.round(motoFareCup + offset), minFareCup);
}
