import type { Ride } from '@tricigo/types';

/**
 * Net earnings for a single completed trip from the driver's perspective:
 *   fare - commission + tip
 *
 * Fare prefers the post-completion `final_fare_cup`; falls back to
 * `estimated_fare_cup` only for rides that never reached completion
 * (e.g. canceled rides accidentally in a list).
 *
 * Commission preference order (matches the receipt PDF — the canonical
 * driver-money source — at `packages/utils/src/receipt-template.ts`):
 *   1. `trip.commission_amount` — the value snapshotted into
 *      `ride_pricing_snapshots` by `complete_ride_and_pay` and joined
 *      onto the ride row by `getRideHistoryFiltered`. Using it keeps
 *      historical earnings frozen at the rate that was live when the
 *      ride completed — a future change to `platform_config.commission_rate`
 *      will NOT retroactively rewrite past income.
 *   2. `Math.round(fare * commissionRate)` — fallback for legacy rides
 *      that completed before the snapshot pipeline landed AND for
 *      pre-acceptance offer cards where the snapshot doesn't exist yet.
 *
 * Tip: 100% of `tip_amount` goes to the driver, so it adds to net.
 * Same contract as the driver receipt's `netCup` calc.
 *
 * Replaces the previous hardcoded `× 0.85` (assumed 15% commission)
 * scattered across IncomingRideCard, TripCompleteView hero, the
 * earnings dashboard chart and the today/prev totals in
 * useEarningsData — all of which disagreed with each other when the
 * platform commission rate ≠ 15%.
 */
export function tripNetEarnings(
  trip: Ride & { commission_amount?: number | null },
  commissionRate: number,
): number {
  const fare = trip.final_fare_cup ?? trip.estimated_fare_cup ?? 0;
  const serverCommission = trip.commission_amount;
  const commission =
    serverCommission != null
      ? serverCommission
      : Math.round(fare * commissionRate);
  const tip = trip.tip_amount ?? 0;
  return fare - commission + tip;
}
