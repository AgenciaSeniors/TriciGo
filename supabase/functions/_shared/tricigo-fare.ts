// ============================================================
// TriciGo — own-price computation for the competitor observatory
//
// Reproduces, server-side, the price a passenger sees for a given route+time,
// using the SAME pure formula the app uses (fare-calculator.ts, the parity-
// tested mirror of packages/utils/src/fareCalculator.ts).
//
// This is the SELECTION/orchestration layer that ride.service.ts:244-323 does
// client-side: pick rates (a matching pricing_rule wins over service_type_configs),
// compute the base fare from FROZEN route geometry, then apply the weather surge.
// It reads live inputs (configs, rules, surge, FX) each cycle — it does not
// snapshot the formula, it snapshots the data.
//
// Deliberate difference from the client: the pricing-band clock. ride.service.ts
// uses the DEVICE clock (now.getHours()); here we use America/Havana explicitly,
// because the server runs in UTC and would otherwise fall in the wrong band. The
// observatory compares against the price a Cuban passenger would see at that hour.
// ============================================================

import { calculateBaseFare, calculateCargoFare, applySurge, matchPricingRule } from './fare-calculator.ts';
import type { PricingRuleMatch } from './fare-calculator.ts';

export interface ServiceTypeConfigRow {
  slug: string;
  base_fare_cup: number;
  per_km_rate_cup: number;
  per_minute_rate_cup: number;
  min_fare_cup: number;
}

export interface OwnFareInputs {
  serviceType: string;
  distanceM: number;
  /** Router duration in seconds (fare duration). Today per_minute_rate_cup=0 so it is unused, but kept correct. */
  durationS: number;
  config: ServiceTypeConfigRow;
  /** Active pricing rules for this service type (may be empty). */
  rules: PricingRuleMatch[];
  /** Weather surge multiplier (>= 1.0). */
  surge: number;
  /** Instant to price at (defaults to now). Used to pick the Havana pricing band. */
  at?: Date;
}

/** Current time in America/Havana as "HH:MM" (24h) and day-of-week (0=Sun). */
export function havanaBand(at: Date = new Date()): { hour: string; day: number } {
  // hour:minute in Havana
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Havana',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at); // "HH:MM"
  // day-of-week in Havana
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Havana',
    weekday: 'short',
  }).format(at); // "Sun".."Sat"
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour: hm, day: dayMap[weekday] ?? 0 };
}

/**
 * Compute TriciGo's fare for a route, mirroring ride.service.ts:244-323.
 * Returns the CUP amount a passenger would be shown (post-surge).
 */
export function computeOwnFare(inputs: OwnFareInputs): number {
  const { config, rules, surge, serviceType } = inputs;

  // Rate selection: a matching pricing rule overrides service_type_configs.
  let baseFare = config.base_fare_cup;
  let perKmRate = config.per_km_rate_cup;
  let perMinRate = config.per_minute_rate_cup;
  let minFare = config.min_fare_cup;

  const { hour, day } = havanaBand(inputs.at ?? new Date());
  if (rules && rules.length > 0) {
    const rule = matchPricingRule(rules, hour, day);
    if (rule) {
      baseFare = rule.base_fare_cup;
      perKmRate = rule.per_km_rate_cup;
      perMinRate = rule.per_minute_rate_cup;
      minFare = rule.min_fare_cup;
    }
  }

  const distanceKm = inputs.distanceM / 1000;
  const fareDurationMin = inputs.durationS / 60;

  let fare: number;
  if (serviceType === 'triciclo_cargo') {
    fare = calculateCargoFare({
      durationMin: fareDurationMin <= 0 ? 60 : fareDurationMin,
      baseFare,
      perMinRate,
      minimumFare: minFare,
    }).fare;
  } else {
    fare = calculateBaseFare({
      distanceKm,
      durationMin: fareDurationMin,
      baseFare,
      perKmRate,
      perMinRate,
      minimumFare: minFare,
    }).fare;
  }

  // Weather surge (the only surge that survives; zone/demand were dropped in 00376).
  if (typeof surge === 'number' && surge > 1.0) {
    fare = applySurge(fare, surge);
  }

  return fare;
}
