// ============================================================
// TriciGo — Fare Calculator (Pure Functions)
//
// Extracted from ride.service.ts so fare logic is testable
// without database dependencies.
// ============================================================

export interface FareParams {
  distanceKm: number;
  durationMin: number;
  baseFare: number;
  perKmRate: number;
  perMinRate: number;
  minimumFare: number;
}

export interface FareResult {
  /** Calculated fare before minimum enforcement */
  rawFare: number;
  /** Final fare (with minimum enforcement) */
  fare: number;
  /** Whether minimum fare was applied */
  minFareApplied: boolean;
}

export interface PricingRuleMatch {
  id: string;
  time_window_start?: string | null;
  time_window_end?: string | null;
  day_of_week?: number[] | null;
  base_fare_cup: number;
  per_km_rate_cup: number;
  per_minute_rate_cup: number;
  min_fare_cup: number;
}

export interface DiscountParams {
  type: 'percentage' | 'fixed';
  value: number;
}

export interface FareRange {
  /** Minimum expected fare in CUP */
  minFareCup: number;
  /** Maximum expected fare in CUP */
  maxFareCup: number;
  /** Minimum expected fare in TRC centavos */
  minFareTrc: number;
  /** Maximum expected fare in TRC centavos */
  maxFareTrc: number;
}

export interface FareRangeParams {
  /** Calculated fare in CUP (after surge) */
  fareCup: number;
  /** Current surge multiplier (1.0 = no surge) */
  surgeMultiplier: number;
  /** Exchange rate: 1 USD = X CUP */
  exchangeRate: number;
  /** Traffic variance factor (default 0.15 = ±15%) */
  trafficVariance?: number;
}

/**
 * Calculate base fare from distance and duration.
 * Formula: baseFare + (distanceKm × perKmRate) + (durationMin × perMinRate)
 * Applies minimum fare constraint.
 */
export function calculateBaseFare(params: FareParams): FareResult {
  const rawFare = Math.round(
    params.baseFare +
    params.distanceKm * params.perKmRate +
    params.durationMin * params.perMinRate,
  );

  const fare = Math.max(rawFare, params.minimumFare);
  return {
    rawFare,
    fare,
    minFareApplied: rawFare < params.minimumFare,
  };
}

/**
 * Apply surge multiplier to a fare amount.
 */
export function applySurge(fare: number, multiplier: number): number {
  if (multiplier <= 0) return fare; // Safety: never reduce below original
  return Math.round(fare * multiplier);
}

/**
 * Calculate discount amount from a fare.
 * Returns the discount amount (not the final fare).
 * Guaranteed non-negative and capped at the fare amount.
 */
export function calculateDiscount(fare: number, discount: DiscountParams): number {
  let amount: number;

  if (discount.type === 'percentage') {
    amount = Math.round((fare * discount.value) / 100);
  } else {
    amount = Math.round(discount.value);
  }

  // Clamp: never negative, never exceed fare
  return Math.max(0, Math.min(amount, fare));
}

/**
 * Find the first matching pricing rule based on current time and day.
 *
 * @param rules - Active pricing rules
 * @param currentHour - Current time as "HH:MM" (24h format)
 * @param currentDay - Day of week (0=Sunday, 6=Saturday)
 * @returns The first matching rule, or null if none match
 */
export function matchPricingRule(
  rules: PricingRuleMatch[],
  currentHour: string,
  currentDay: number,
): PricingRuleMatch | null {
  for (const rule of rules) {
    // Check time window
    if (rule.time_window_start && rule.time_window_end) {
      if (currentHour < rule.time_window_start || currentHour >= rule.time_window_end) {
        continue;
      }
    }
    // Check day of week
    if (rule.day_of_week && rule.day_of_week.length > 0) {
      if (!rule.day_of_week.includes(currentDay)) {
        continue;
      }
    }
    return rule;
  }
  return null;
}

/**
 * Calculate fare range (min-max) considering traffic variance and surge.
 *
 * - Min: fare × (1 - variance) — optimistic (less traffic)
 * - Max: fare × (1 + variance) — pessimistic (more traffic)
 * - If surge > 1, max also factors in surge ceiling
 *
 * @returns Range in both CUP and TRC centavos
 */
export function calculateFareRange(params: FareRangeParams): FareRange {
  const variance = params.trafficVariance ?? 0.15;
  const { fareCup, surgeMultiplier, exchangeRate } = params;

  const minFareCup = Math.round(fareCup * (1 - variance));
  // Max considers both traffic variance and potential surge increase
  const surgeBoost = surgeMultiplier > 1 ? 1.0 + (surgeMultiplier - 1.0) * 0.5 : 1.0;
  const maxFareCup = Math.round(fareCup * (1 + variance) * surgeBoost);

  // Convert to TRC using cupToTrcCentavos pattern (inline to keep pure)
  const toTrc = (cup: number): number => {
    if (exchangeRate <= 0) return 0;
    return Math.round((cup / exchangeRate) * 100);
  };

  return {
    minFareCup,
    maxFareCup,
    minFareTrc: toTrc(minFareCup),
    maxFareTrc: toTrc(maxFareCup),
  };
}
