// Unit tests for the observatory's own-price computation (tricigo-fare.ts).
// Run by the @tricigo/api vitest project.

import { describe, it, expect } from 'vitest';
import { computeOwnFare, havanaBand } from './tricigo-fare';
import type { PricingRuleMatch } from './fare-calculator';

const config = {
  slug: 'auto_standard',
  base_fare_cup: 540,
  per_km_rate_cup: 549,
  per_minute_rate_cup: 0,
  min_fare_cup: 1656,
};

describe('computeOwnFare', () => {
  it('uses service_type_configs when there are no rules', () => {
    // 4.39 km × 549 + 540 = 540 + 2410.11 = 2950.11 → round 2950
    const fare = computeOwnFare({
      serviceType: 'auto_standard',
      distanceM: 4390,
      durationS: 720,
      config,
      rules: [],
      surge: 1.0,
    });
    expect(fare).toBe(2950);
  });

  it('enforces the minimum fare on short trips', () => {
    // 0.4 km × 549 + 540 = 759.6 → 760, below min 1656 → 1656
    const fare = computeOwnFare({
      serviceType: 'auto_standard',
      distanceM: 400,
      durationS: 120,
      config,
      rules: [],
      surge: 1.0,
    });
    expect(fare).toBe(1656);
  });

  it('a matching pricing rule overrides the config rates', () => {
    // Rule active all day: base 300, per_km 30, min 700
    const rules: PricingRuleMatch[] = [
      { id: 'allday', time_window_start: '00:00', time_window_end: '00:00', day_of_week: null, base_fare_cup: 300, per_km_rate_cup: 30, per_minute_rate_cup: 0, min_fare_cup: 700 },
    ];
    // window start == end: matchPricingRule treats it as a normal window where
    // currentHour < start OR >= end skips — so this rule never matches. Use a real window instead.
    const realRule: PricingRuleMatch[] = [
      { id: 'afternoon', time_window_start: '00:00', time_window_end: '23:59', day_of_week: null, base_fare_cup: 300, per_km_rate_cup: 30, per_minute_rate_cup: 0, min_fare_cup: 700 },
    ];
    const at = new Date('2026-06-15T18:00:00Z'); // 14:00 Havana (UTC-4 in summer)
    const fare = computeOwnFare({
      serviceType: 'auto_standard',
      distanceM: 10000,
      durationS: 1200,
      config,
      rules: realRule,
      surge: 1.0,
      at,
    });
    // 10 km × 30 + 300 = 600, below min 700 → 700
    expect(fare).toBe(700);
    // sanity: the unused `rules` var above is a doc of the window-equality gotcha
    expect(rules.length).toBe(1);
  });

  it('applies weather surge only when > 1.0', () => {
    const base = computeOwnFare({ serviceType: 'auto_standard', distanceM: 4390, durationS: 720, config, rules: [], surge: 1.0 });
    const surged = computeOwnFare({ serviceType: 'auto_standard', distanceM: 4390, durationS: 720, config, rules: [], surge: 1.3 });
    expect(surged).toBe(Math.round(base * 1.3));
  });

  it('cargo uses hourly pricing with a 1-hour minimum', () => {
    const cargoConfig = { slug: 'triciclo_cargo', base_fare_cup: 1000, per_km_rate_cup: 0, per_minute_rate_cup: 10, min_fare_cup: 500 };
    // 90 min → ceil(90/60)=2 hours × (10×60) + 1000 = 2200
    const fare = computeOwnFare({ serviceType: 'triciclo_cargo', distanceM: 5000, durationS: 5400, config: cargoConfig, rules: [], surge: 1.0 });
    expect(fare).toBe(2200);
  });
});

describe('havanaBand', () => {
  it('returns HH:MM and a 0-6 day for a known instant', () => {
    // 2026-06-15 is a Monday; 18:00Z = 14:00 Havana (summer, UTC-4)
    const { hour, day } = havanaBand(new Date('2026-06-15T18:00:00Z'));
    expect(hour).toBe('14:00');
    expect(day).toBe(1); // Monday
  });

  it('rolls the day back when UTC is past midnight but Havana is not', () => {
    // 2026-06-16 02:00Z = 2026-06-15 22:00 Havana → still Monday
    const { hour, day } = havanaBand(new Date('2026-06-16T02:00:00Z'));
    expect(hour).toBe('22:00');
    expect(day).toBe(1);
  });
});
