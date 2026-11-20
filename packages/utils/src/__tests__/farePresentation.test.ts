import { describe, it, expect } from 'vitest';
import {
  riderChargedTotal,
  riderChargedTotalTrc,
  riderExpectedFareCup,
  riderExpectedFareTrc,
  TIP_PERCENT_OPTIONS,
  tipAmountForPercent,
} from '../farePresentation';

describe('riderExpectedFareCup', () => {
  it('returns the estimate when there is no discount', () => {
    expect(riderExpectedFareCup({ estimated_fare_cup: 6656 })).toBe(6656);
    expect(riderExpectedFareCup({ estimated_fare_cup: 6656, discount_amount_cup: 0 })).toBe(6656);
    expect(riderExpectedFareCup({ estimated_fare_cup: 6656, discount_amount_cup: null })).toBe(6656);
  });

  // Ride 278742d6 (2026-11-19): PERDON10 took 666 off a 6,656 CUP ride, and
  // the searching card still said 6,656.
  it('subtracts the discount before the ride is completed', () => {
    expect(riderExpectedFareCup({ estimated_fare_cup: 6656, discount_amount_cup: 666 })).toBe(5990);
  });

  it('never goes below 0', () => {
    expect(riderExpectedFareCup({ estimated_fare_cup: 500, discount_amount_cup: 900 })).toBe(0);
  });

  it('uses the final fare once there is one (it already has the discount)', () => {
    expect(riderExpectedFareCup({
      final_fare_cup: 5990,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
    })).toBe(5990);
    expect(riderExpectedFareCup({ final_fare_cup: 0, estimated_fare_cup: 6656, discount_amount_cup: 666 })).toBe(0);
  });

  it('returns 0 when there is no fare at all', () => {
    expect(riderExpectedFareCup({})).toBe(0);
    expect(riderExpectedFareCup({ final_fare_cup: null, estimated_fare_cup: null, discount_amount_cup: 666 })).toBe(0);
  });
});

describe('riderExpectedFareTrc', () => {
  it('returns null when the ride has no TRC fare', () => {
    expect(riderExpectedFareTrc({ estimated_fare_cup: 6656, discount_amount_cup: 666 })).toBe(null);
    expect(riderExpectedFareTrc({ estimated_fare_trc: null, final_fare_trc: null })).toBe(null);
  });

  it('returns the estimate when there is no discount', () => {
    expect(riderExpectedFareTrc({ estimated_fare_trc: 6656, estimated_fare_cup: 6656 })).toBe(6656);
  });

  it('applies the CUP discount (1 TRC = 1 CUP)', () => {
    expect(riderExpectedFareTrc({
      estimated_fare_trc: 6656,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
    })).toBe(5990);
  });

  it('scales the discount when an older ride kept TRC and CUP apart', () => {
    expect(riderExpectedFareTrc({
      estimated_fare_trc: 1000,
      estimated_fare_cup: 2000,
      discount_amount_cup: 500,
    })).toBe(750);
  });

  it('never goes below 0', () => {
    expect(riderExpectedFareTrc({
      estimated_fare_trc: 500,
      estimated_fare_cup: 500,
      discount_amount_cup: 900,
    })).toBe(0);
  });

  it('uses the final TRC fare once there is one', () => {
    expect(riderExpectedFareTrc({
      final_fare_trc: 5990,
      estimated_fare_trc: 6656,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
    })).toBe(5990);
  });
});

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

  it('subtracts the discount while there is no final fare yet', () => {
    expect(riderChargedTotal({
      final_fare_cup: null,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
    })).toBe(5990);
  });

  it('does not subtract the discount again from the final fare', () => {
    expect(riderChargedTotal({
      final_fare_cup: 5990,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
      tip_amount: 10,
    })).toBe(6000);
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

  it('subtracts the discount while there is no final fare yet', () => {
    expect(riderChargedTotalTrc({
      final_fare_trc: null,
      estimated_fare_trc: 6656,
      estimated_fare_cup: 6656,
      discount_amount_cup: 666,
    })).toBe(5990);
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
