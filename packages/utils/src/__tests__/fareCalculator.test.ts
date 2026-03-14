import { describe, it, expect } from 'vitest';
import {
  calculateBaseFare,
  applySurge,
  calculateDiscount,
  matchPricingRule,
  calculateFareRange,
} from '../fareCalculator';
import type { FareParams, PricingRuleMatch } from '../fareCalculator';

// ============================================================
// calculateBaseFare
// ============================================================
describe('calculateBaseFare', () => {
  const defaultParams: FareParams = {
    distanceKm: 5,
    durationMin: 15,
    baseFare: 50,     // 50 CUP base
    perKmRate: 30,    // 30 CUP/km
    perMinRate: 5,    // 5 CUP/min
    minimumFare: 100, // 100 CUP minimum
  };

  it('calculates fare = base + (km × rate) + (min × rate)', () => {
    // 50 + (5 × 30) + (15 × 5) = 50 + 150 + 75 = 275
    const result = calculateBaseFare(defaultParams);
    expect(result.rawFare).toBe(275);
    expect(result.fare).toBe(275);
    expect(result.minFareApplied).toBe(false);
  });

  it('applies minimum fare when calculated fare is below minimum', () => {
    const params: FareParams = {
      distanceKm: 0.2,
      durationMin: 1,
      baseFare: 10,
      perKmRate: 30,
      perMinRate: 5,
      minimumFare: 100,
    };
    // 10 + (0.2 × 30) + (1 × 5) = 10 + 6 + 5 = 21 → rounded to 21
    const result = calculateBaseFare(params);
    expect(result.rawFare).toBe(21);
    expect(result.fare).toBe(100); // minimum fare
    expect(result.minFareApplied).toBe(true);
  });

  it('handles zero distance and duration', () => {
    const params: FareParams = {
      distanceKm: 0,
      durationMin: 0,
      baseFare: 50,
      perKmRate: 30,
      perMinRate: 5,
      minimumFare: 100,
    };
    // 50 + 0 + 0 = 50, min 100
    const result = calculateBaseFare(params);
    expect(result.rawFare).toBe(50);
    expect(result.fare).toBe(100);
    expect(result.minFareApplied).toBe(true);
  });

  it('handles large distances', () => {
    const params: FareParams = {
      distanceKm: 50,
      durationMin: 120,
      baseFare: 50,
      perKmRate: 30,
      perMinRate: 5,
      minimumFare: 100,
    };
    // 50 + (50 × 30) + (120 × 5) = 50 + 1500 + 600 = 2150
    const result = calculateBaseFare(params);
    expect(result.fare).toBe(2150);
  });

  it('rounds to nearest integer', () => {
    const params: FareParams = {
      distanceKm: 1.5,
      durationMin: 3.3,
      baseFare: 50,
      perKmRate: 33,
      perMinRate: 7,
      minimumFare: 10,
    };
    // 50 + (1.5 × 33) + (3.3 × 7) = 50 + 49.5 + 23.1 = 122.6 → 123
    const result = calculateBaseFare(params);
    expect(result.rawFare).toBe(123);
  });
});

// ============================================================
// applySurge
// ============================================================
describe('applySurge', () => {
  it('returns same fare at 1x multiplier', () => {
    expect(applySurge(275, 1.0)).toBe(275);
  });

  it('applies 1.5x surge', () => {
    // 275 × 1.5 = 412.5 → 413
    expect(applySurge(275, 1.5)).toBe(413);
  });

  it('applies 2x surge', () => {
    expect(applySurge(275, 2.0)).toBe(550);
  });

  it('rounds to integer', () => {
    // 100 × 1.3 = 130
    expect(applySurge(100, 1.3)).toBe(130);
  });

  it('handles zero multiplier (safety — returns original)', () => {
    expect(applySurge(275, 0)).toBe(275);
  });

  it('handles negative multiplier (safety — returns original)', () => {
    expect(applySurge(275, -1)).toBe(275);
  });

  it('handles zero fare', () => {
    expect(applySurge(0, 1.5)).toBe(0);
  });
});

// ============================================================
// calculateDiscount
// ============================================================
describe('calculateDiscount', () => {
  describe('percentage discount', () => {
    it('calculates percentage correctly', () => {
      // 20% of 1000 = 200
      expect(calculateDiscount(1000, { type: 'percentage', value: 20 })).toBe(200);
    });

    it('handles 100% discount', () => {
      expect(calculateDiscount(500, { type: 'percentage', value: 100 })).toBe(500);
    });

    it('handles 0% discount', () => {
      expect(calculateDiscount(500, { type: 'percentage', value: 0 })).toBe(0);
    });

    it('rounds to integer', () => {
      // 15% of 275 = 41.25 → 41
      expect(calculateDiscount(275, { type: 'percentage', value: 15 })).toBe(41);
    });
  });

  describe('fixed discount', () => {
    it('applies fixed discount amount', () => {
      expect(calculateDiscount(1000, { type: 'fixed', value: 200 })).toBe(200);
    });

    it('caps discount at fare amount (never negative fare)', () => {
      expect(calculateDiscount(100, { type: 'fixed', value: 500 })).toBe(100);
    });

    it('handles zero fixed discount', () => {
      expect(calculateDiscount(500, { type: 'fixed', value: 0 })).toBe(0);
    });
  });

  it('handles zero fare', () => {
    expect(calculateDiscount(0, { type: 'percentage', value: 20 })).toBe(0);
    expect(calculateDiscount(0, { type: 'fixed', value: 100 })).toBe(0);
  });

  it('handles negative discount value (clamp to 0)', () => {
    expect(calculateDiscount(500, { type: 'fixed', value: -50 })).toBe(0);
  });
});

// ============================================================
// matchPricingRule
// ============================================================
describe('matchPricingRule', () => {
  const rules: PricingRuleMatch[] = [
    {
      id: 'rule-peak',
      time_window_start: '07:00',
      time_window_end: '10:00',
      day_of_week: null,
      base_fare_cup: 80,
      per_km_rate_cup: 45,
      per_minute_rate_cup: 8,
      min_fare_cup: 150,
    },
    {
      id: 'rule-weekend',
      time_window_start: null,
      time_window_end: null,
      day_of_week: [0, 6], // Sunday, Saturday
      base_fare_cup: 60,
      per_km_rate_cup: 35,
      per_minute_rate_cup: 6,
      min_fare_cup: 120,
    },
    {
      id: 'rule-always',
      time_window_start: null,
      time_window_end: null,
      day_of_week: null,
      base_fare_cup: 50,
      per_km_rate_cup: 30,
      per_minute_rate_cup: 5,
      min_fare_cup: 100,
    },
  ];

  it('matches time-based rule within window', () => {
    const result = matchPricingRule(rules, '08:30', 1); // Monday 08:30 (within 07-10)
    expect(result?.id).toBe('rule-peak');
  });

  it('skips time-based rule outside window', () => {
    const result = matchPricingRule(rules, '14:00', 6); // Saturday 14:00
    // Peak rule doesn't match (14:00 not in 07-10)
    // Weekend rule matches (day 6 is Saturday)
    expect(result?.id).toBe('rule-weekend');
  });

  it('matches day-of-week rule', () => {
    const result = matchPricingRule(rules, '14:00', 0); // Sunday 14:00
    // Peak doesn't match (14:00 not in 07-10), Weekend matches (Sunday)
    expect(result?.id).toBe('rule-weekend');
  });

  it('falls through to catch-all rule', () => {
    // Remove first two rules
    const catchAll = [rules[2]];
    const result = matchPricingRule(catchAll, '14:00', 3); // Wednesday 14:00
    expect(result?.id).toBe('rule-always');
  });

  it('returns null when no rules match', () => {
    const strictRules: PricingRuleMatch[] = [
      {
        id: 'rule-strict',
        time_window_start: '01:00',
        time_window_end: '02:00',
        day_of_week: [1], // Monday only
        base_fare_cup: 80,
        per_km_rate_cup: 45,
        per_minute_rate_cup: 8,
        min_fare_cup: 150,
      },
    ];
    const result = matchPricingRule(strictRules, '14:00', 3); // Wednesday 14:00
    expect(result).toBeNull();
  });

  it('returns null for empty rules array', () => {
    expect(matchPricingRule([], '14:00', 3)).toBeNull();
  });

  it('returns first matching rule (priority)', () => {
    const result = matchPricingRule(rules, '14:00', 3); // Wednesday 14:00
    // Night: no (14:00 out of window)
    // Weekend: no (Wednesday = day 3)
    // Always: yes
    expect(result?.id).toBe('rule-always');
  });
});

// ============================================================
// calculateFareRange
// ============================================================
describe('calculateFareRange', () => {
  it('calculates symmetric range without surge (±15% default)', () => {
    const result = calculateFareRange({
      fareCup: 1000,
      surgeMultiplier: 1.0,
      exchangeRate: 500,
    });
    // min: 1000 * 0.85 = 850
    // max: 1000 * 1.15 * 1.0 = 1150
    expect(result.minFareCup).toBe(850);
    expect(result.maxFareCup).toBe(1150);
  });

  it('converts range to TRC centavos correctly', () => {
    const result = calculateFareRange({
      fareCup: 1000,
      surgeMultiplier: 1.0,
      exchangeRate: 500,
    });
    // min TRC: 850 / 500 * 100 = 170
    // max TRC: 1150 / 500 * 100 = 230
    expect(result.minFareTrc).toBe(170);
    expect(result.maxFareTrc).toBe(230);
  });

  it('widens max range when surge is active', () => {
    const result = calculateFareRange({
      fareCup: 1000,
      surgeMultiplier: 1.5,
      exchangeRate: 500,
    });
    // min: 1000 * 0.85 = 850
    // surgeBoost: 1.0 + (1.5 - 1.0) * 0.5 = 1.25
    // max: 1000 * 1.15 * 1.25 = 1438
    expect(result.minFareCup).toBe(850);
    expect(result.maxFareCup).toBe(1438);
  });

  it('respects custom variance', () => {
    const result = calculateFareRange({
      fareCup: 1000,
      surgeMultiplier: 1.0,
      exchangeRate: 500,
      trafficVariance: 0.10, // ±10%
    });
    expect(result.minFareCup).toBe(900);
    expect(result.maxFareCup).toBe(1100);
  });

  it('handles zero exchange rate safely', () => {
    const result = calculateFareRange({
      fareCup: 1000,
      surgeMultiplier: 1.0,
      exchangeRate: 0,
    });
    expect(result.minFareTrc).toBe(0);
    expect(result.maxFareTrc).toBe(0);
  });

  it('handles zero fare', () => {
    const result = calculateFareRange({
      fareCup: 0,
      surgeMultiplier: 1.0,
      exchangeRate: 500,
    });
    expect(result.minFareCup).toBe(0);
    expect(result.maxFareCup).toBe(0);
  });
});
