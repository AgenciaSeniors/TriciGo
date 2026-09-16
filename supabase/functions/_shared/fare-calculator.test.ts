// ============================================================
// Parity test: the Edge Function fare-calculator mirror MUST behave
// identically to packages/utils/src/fareCalculator.ts.
//
// The competitor-price observatory computes TriciGo's own fare server-side with
// the mirror (supabase/functions/_shared/fare-calculator.ts) so that every
// captured competitor quote is paired with the price a passenger would see for
// the same route in the same instant. If the mirror drifts from the canonical
// calculator, that pairing lies. This test makes drift a red build, not a
// silent divergence discovered months later (cf. the 4-month-stale FX scraper).
//
// It imports BOTH copies and asserts bit-for-bit equality across a grid of
// inputs. Change one copy without the other → this test fails.
//
// Runner: the @tricigo/api vitest project (packages/api/vitest.config.ts
// includes ../../supabase/functions/_shared/**/*.test.ts).
// ============================================================

import { describe, it, expect } from 'vitest';

import * as canonical from '../../../packages/utils/src/fareCalculator';
import * as mirror from './fare-calculator';

// Grids kept deliberately wide: short/long trips, zero and non-zero per-minute
// rates (today per_minute_rate_cup = 0 per migration 00470, but the mirror must
// stay correct for the day it is reactivated), and minimum-fare enforcement on
// both sides of the threshold.
const DISTANCES_KM = [0, 0.4, 1, 2.03, 4.39, 7.5, 12, 25, 49];
const DURATIONS_MIN = [0, 3, 6, 12, 20, 45, 90];
const BASE_FARES = [0, 218, 540, 769, 1424, 1455];
const PER_KM_RATES = [0, 110, 161, 337, 549, 640];
const PER_MIN_RATES = [0, 5, 13];
const MIN_FARES = [0, 665, 1397, 1656, 2753, 9221];
const SURGE_MULTIPLIERS = [0, 1.0, 1.2, 1.3, 1.5, 1.8, 2.0, 3.0];

describe('fare-calculator mirror parity', () => {
  it('calculateBaseFare is identical across a wide input grid', () => {
    for (const distanceKm of DISTANCES_KM) {
      for (const durationMin of DURATIONS_MIN) {
        for (const baseFare of BASE_FARES) {
          for (const perKmRate of PER_KM_RATES) {
            for (const perMinRate of PER_MIN_RATES) {
              for (const minimumFare of MIN_FARES) {
                const params = { distanceKm, durationMin, baseFare, perKmRate, perMinRate, minimumFare };
                expect(mirror.calculateBaseFare(params)).toEqual(canonical.calculateBaseFare(params));
              }
            }
          }
        }
      }
    }
  });

  it('calculateCargoFare is identical', () => {
    for (const durationMin of DURATIONS_MIN) {
      for (const baseFare of BASE_FARES) {
        for (const perMinRate of PER_MIN_RATES) {
          for (const minimumFare of MIN_FARES) {
            const params = { durationMin, baseFare, perMinRate, minimumFare };
            expect(mirror.calculateCargoFare(params)).toEqual(canonical.calculateCargoFare(params));
          }
        }
      }
    }
  });

  it('applySurge is identical', () => {
    for (const fare of [0, 665, 1397, 1656, 2753, 9221, 12345]) {
      for (const multiplier of SURGE_MULTIPLIERS) {
        expect(mirror.applySurge(fare, multiplier)).toBe(canonical.applySurge(fare, multiplier));
      }
    }
  });

  it('calculateFareRange is identical', () => {
    for (const fareCup of [0, 665, 1656, 9221]) {
      for (const surgeMultiplier of [1.0, 1.3, 2.0]) {
        for (const exchangeRate of [0, 300, 520, 665]) {
          for (const trafficVariance of [undefined, 0.1, 0.15, 0.25]) {
            const params = { fareCup, surgeMultiplier, exchangeRate, trafficVariance };
            expect(mirror.calculateFareRange(params)).toEqual(canonical.calculateFareRange(params));
          }
        }
      }
    }
  });

  it('matchPricingRule picks the same rule (normal, overnight, and day-of-week windows)', () => {
    const rules = [
      { id: 'dawn', time_window_start: '00:00', time_window_end: '06:00', day_of_week: null, base_fare_cup: 100, per_km_rate_cup: 10, per_minute_rate_cup: 0, min_fare_cup: 500 },
      { id: 'morning', time_window_start: '06:00', time_window_end: '12:00', day_of_week: null, base_fare_cup: 200, per_km_rate_cup: 20, per_minute_rate_cup: 0, min_fare_cup: 600 },
      { id: 'afternoon', time_window_start: '12:00', time_window_end: '18:00', day_of_week: null, base_fare_cup: 300, per_km_rate_cup: 30, per_minute_rate_cup: 0, min_fare_cup: 700 },
      { id: 'night', time_window_start: '18:00', time_window_end: '00:00', day_of_week: null, base_fare_cup: 400, per_km_rate_cup: 40, per_minute_rate_cup: 0, min_fare_cup: 800 },
      { id: 'overnight-weekend', time_window_start: '22:00', time_window_end: '06:00', day_of_week: [0, 6], base_fare_cup: 999, per_km_rate_cup: 99, per_minute_rate_cup: 0, min_fare_cup: 999 },
    ];
    const hours = ['00:00', '03:30', '05:59', '06:00', '11:59', '12:00', '17:59', '18:00', '22:00', '23:30'];
    for (const currentHour of hours) {
      for (let currentDay = 0; currentDay <= 6; currentDay++) {
        expect(mirror.matchPricingRule(rules, currentHour, currentDay))
          .toEqual(canonical.matchPricingRule(rules, currentHour, currentDay));
      }
    }
  });

  it('calculateDiscount is identical', () => {
    for (const fare of [0, 665, 1656, 9221]) {
      for (const type of ['percentage', 'fixed'] as const) {
        for (const value of [0, 5, 10, 50, 100, 5000, 99999]) {
          expect(mirror.calculateDiscount(fare, { type, value }))
            .toBe(canonical.calculateDiscount(fare, { type, value }));
        }
      }
    }
  });

  it('calculateWaitCharge is identical', () => {
    for (const totalWaitMin of [0, 2.5, 5, 5.9, 10, 30]) {
      for (const freeMinutes of [0, 3, 5]) {
        for (const perWaitMinRate of [0, 10, 25]) {
          const params = { totalWaitMin, freeMinutes, perWaitMinRate };
          expect(mirror.calculateWaitCharge(params)).toEqual(canonical.calculateWaitCharge(params));
        }
      }
    }
  });
});
