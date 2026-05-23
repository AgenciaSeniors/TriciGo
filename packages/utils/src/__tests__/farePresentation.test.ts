import { describe, it, expect } from 'vitest';
import { riderChargedTotal, riderChargedTotalTrc } from '../farePresentation';

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
