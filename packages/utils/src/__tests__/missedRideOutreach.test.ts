import { describe, it, expect } from 'vitest';
import { apologyDiscountText, cubaDayMonth, missedRideApologyMessage } from '../missedRideOutreach';

const FIXED = { type: 'fixed_discount', discountPercent: null, discountFixedCup: 500, validUntil: null };
const PERCENT = { type: 'percentage_discount', discountPercent: 25, discountFixedCup: null, validUntil: null };

describe('cubaDayMonth', () => {
  it("writes the day in Cuba's clock", () => {
    // 2026-10-29 02:00 UTC is still the 28th in Havana (UTC-4).
    expect(cubaDayMonth('2026-10-29T02:00:00Z')).toBe('28 de octubre');
  });
});

describe('apologyDiscountText', () => {
  it('formats a fixed amount in CUP', () => {
    expect(apologyDiscountText(FIXED)).toBe('500 CUP');
  });

  it('formats a percentage', () => {
    expect(apologyDiscountText(PERCENT)).toBe('un 25 %');
  });

  it('returns null when the coupon gives nothing', () => {
    expect(apologyDiscountText({ ...FIXED, discountFixedCup: 0 })).toBeNull();
    expect(apologyDiscountText({ ...PERCENT, discountPercent: null })).toBeNull();
  });
});

describe('missedRideApologyMessage', () => {
  it('apologises by first name and offers the coupon', () => {
    expect(missedRideApologyMessage({ fullName: '  Ana María Pérez ', failedAt: '2026-10-28T15:00:00Z', coupon: FIXED })).toBe(
      'Hola, Ana. Te escribimos de TriciGo. El 28 de octubre pediste un viaje y no conseguimos conductor. Lo sentimos mucho. '
        + 'Te dejamos 500 CUP de descuento en tu próximo viaje. Ya está cargado en tu cuenta, no tienes que escribir ningún código.',
    );
  });

  it('says until when the coupon is valid', () => {
    const msg = missedRideApologyMessage({
      fullName: 'Ana', failedAt: '2026-10-28T15:00:00Z', coupon: { ...PERCENT, validUntil: '2026-11-30T12:00:00Z' },
    });
    expect(msg).toContain('Te dejamos un 25 % de descuento');
    expect(msg.endsWith('Vale hasta el 30 de noviembre.')).toBe(true);
  });

  it('only apologises when there is no coupon', () => {
    expect(missedRideApologyMessage({ fullName: null, failedAt: '2026-10-28T15:00:00Z', coupon: null })).toBe(
      'Hola. Te escribimos de TriciGo. El 28 de octubre pediste un viaje y no conseguimos conductor. Lo sentimos mucho. '
        + 'Esperamos verte pronto en TriciGo.',
    );
  });
});
