import { describe, it, expect } from 'vitest';
import {
  motoDeportivaCard, shouldOfferMotoFallback, MOTO_FALLBACK_AFTER_S,
  parseMotoDeportivaStatus, applyMotoDeportivaOffset,
} from '../motoDeportiva';

describe('motoDeportivaCard', () => {
  it('hides the card when hidden or unknown', () => {
    expect(motoDeportivaCard(null).visible).toBe(false);
    expect(motoDeportivaCard({ status: 'hidden', waiting: false }).visible).toBe(false);
  });
  it('offers Avísame while off or offline', () => {
    expect(motoDeportivaCard({ status: 'offline', waiting: false })).toEqual({
      visible: true, requestable: false, reason: 'unavailable', waitlist: 'join',
    });
    expect(motoDeportivaCard({ status: 'off', waiting: true }).waitlist).toBe('joined');
  });
  it('is busy without Avísame', () => {
    expect(motoDeportivaCard({ status: 'busy', waiting: true })).toEqual({
      visible: true, requestable: false, reason: 'busy', waitlist: 'none',
    });
  });
  it('is requestable when available', () => {
    expect(motoDeportivaCard({ status: 'available', waiting: false })).toEqual({
      visible: true, requestable: true, reason: null, waitlist: 'none',
    });
  });
});

describe('parseMotoDeportivaStatus', () => {
  it('accepts the RPC shape and rejects anything else', () => {
    expect(parseMotoDeportivaStatus({ status: 'busy', waiting: true })).toEqual({ status: 'busy', waiting: true });
    expect(parseMotoDeportivaStatus({ status: 'weird' })).toBeNull();
    expect(parseMotoDeportivaStatus(null)).toBeNull();
  });
});

describe('shouldOfferMotoFallback', () => {
  it('waits 120 s and only for a searching moto_deportiva ride', () => {
    expect(MOTO_FALLBACK_AFTER_S).toBe(120);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'searching', elapsedSeconds: 119 })).toBe(false);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'searching', elapsedSeconds: 120 })).toBe(true);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_standard', status: 'searching', elapsedSeconds: 500 })).toBe(false);
    expect(shouldOfferMotoFallback({ serviceType: 'moto_deportiva', status: 'accepted', elapsedSeconds: 500 })).toBe(false);
  });
});

describe('applyMotoDeportivaOffset', () => {
  it('subtracts 200 from the moto fare', () => {
    expect(applyMotoDeportivaOffset(1500, -200, 553)).toBe(1300);
  });
  it('never goes below the Moto Deportiva minimum', () => {
    expect(applyMotoDeportivaOffset(753, -200, 600)).toBe(600);
  });
  it('treats a missing or non-numeric offset as 0', () => {
    expect(applyMotoDeportivaOffset(1500, Number.NaN, 553)).toBe(1500);
  });
});
