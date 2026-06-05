import { describe, it, expect } from 'vitest';
import {
  riderChargedTotal,
  riderChargedTotalTrc,
  TIP_PERCENT_OPTIONS,
  tipAmountForPercent,
} from '../farePresentation';

describe('riderChargedTotal', () => {
  it('returns final_fare_cup + tip_amount when both present', () => {
    expect(riderChargedTotal({ final_fare_cup: 200, tip_amount: 20 })).toBe(220);
  });

  it('returns final_fare_cup when no tip', () => {
    expect(riderChargedTotal({ final_fare_cup: 200, tip_amount: 0 })).toBe(200);
    expect(riderChargedTotal({ final_fare_cup: 200, tip_amount: null })).toBe(200);
    expect(riderChargedTotal({ final_fare_cup: 200 })).toBe(200);
  });

  it('falls back to estimated_fare_cup when final is null', () => {
    expect(riderChargedTotal({
      final_fare_cup: null,
      estimated_fare_cup: 150,
      tip_amount: 10,
    })).toBe(160);
  });

  it('returns 0 when both fares are null', () => {
    expect(riderChargedTotal({})).toBe(0);
    expect(riderChargedTotal({ final_fare_cup: null, estimated_fare_cup: null })).toBe(0);
  });

  it('handles tip without fare gracefully (edge case: incomplete data)', () => {
    expect(riderChargedTotal({ tip_amount: 20 })).toBe(20);
  });

  // Real-world scenario from the audit: rider pays via wallet, the
  // wallet debits final_fare_cup + tip but the UI was showing only
  // final_fare_cup. This helper restores math truth.
  it('matches what the wallet actually debited (final 200 + tip 20 = 220)', () => {
    const ride = { final_fare_cup: 200, tip_amount: 20 };
    expect(riderChargedTotal(ride)).toBe(220);
  });
});

describe('riderChargedTotalTrc', () => {
  it('returns final_fare_trc + tip_amount when both present', () => {
    expect(riderChargedTotalTrc({ final_fare_trc: 200, tip_amount: 20 })).toBe(220);
  });

  it('returns null when no TRC field (cash ride)', () => {
    expect(riderChargedTotalTrc({ tip_amount: 20 })).toBe(null);
    expect(riderChargedTotalTrc({ final_fare_trc: null, estimated_fare_trc: null })).toBe(null);
  });

  it('falls back to estimated_fare_trc when final is null', () => {
    expect(riderChargedTotalTrc({
      final_fare_trc: null,
      estimated_fare_trc: 100,
      tip_amount: 5,
    })).toBe(105);
  });
});

describe('TIP_PERCENT_OPTIONS', () => {
  it('offers 10/15/20 percent presets', () => {
    expect(TIP_PERCENT_OPTIONS).toEqual([10, 15, 20]);
  });
});

describe('tipAmountForPercent', () => {
  it('computes a percentage of the fare (1 TRC = 1 CUP)', () => {
    expect(tipAmountForPercent(2200, 15)).toBe(330);
    expect(tipAmountForPercent(1000, 10)).toBe(100);
    expect(tipAmountForPercent(1000, 20)).toBe(200);
    expect(tipAmountForPercent(1440, 15)).toBe(216);
  });

  it('rounds to the nearest whole TRC', () => {
    expect(tipAmountForPercent(1234, 10)).toBe(123); // 123.4 → 123
    expect(tipAmountForPercent(1278, 10)).toBe(128); // 127.8 → 128
  });

  it('returns 0 for a non-positive fare', () => {
    expect(tipAmountForPercent(0, 15)).toBe(0);
    expect(tipAmountForPercent(-100, 15)).toBe(0);
  });

  it('returns 0 for a non-positive percentage', () => {
    expect(tipAmountForPercent(1000, 0)).toBe(0);
    expect(tipAmountForPercent(1000, -5)).toBe(0);
  });

  it('is safe under NaN / Infinity input', () => {
    expect(tipAmountForPercent(NaN, 15)).toBe(0);
    expect(tipAmountForPercent(1000, NaN)).toBe(0);
    expect(tipAmountForPercent(Infinity, 15)).toBe(0);
  });
});
