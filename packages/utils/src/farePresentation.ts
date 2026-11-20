// ============================================================
// TriciGo — Fare Presentation Helpers
//
// Display-layer helpers that read DB-shaped `Ride` rows and answer
// "what number should appear on screen / in a PDF / in a receipt".
//
// Distinct from `fareCalculator.ts` (pure functions for pre-completion
// estimate computation). These helpers know the post-completion data
// model — specifically the gap that `rides.final_fare_cup` does NOT
// include `tip_amount` (the `add_tip` RPC updates only `tip_amount`
// without recomputing `final_fare_cup`).
// ============================================================

/**
 * Minimum DB shape needed to tell the rider what a ride costs them.
 * Loose Pick<Ride, ...> typing so callers can pass partial rows.
 */
export interface RiderExpectedFareInput {
  final_fare_cup?: number | null;
  estimated_fare_cup?: number | null;
  /**
   * Promo, apology coupon, partner place and shared-ride discount, all in
   * one number. `tg_rides_validate_promo_discount` sets it on the server
   * and caps it at the estimate.
   */
  discount_amount_cup?: number | null;
}

/**
 * What the rider pays for a ride, in CUP, before any tip.
 *
 * Once the ride is completed this is `final_fare_cup`, which
 * `complete_ride_and_pay` writes with the discount already taken off.
 * Before that it is the estimate minus the discount: `estimated_fare_cup`
 * is the gross fare (the snapshot contract), and the discount comes off
 * only when the ride is charged. Showing the estimate alone made the
 * discount the rider saw while booking disappear once they asked for the
 * ride (ride 278742d6, 2026-11-19: 6,656 shown, 5,990 charged).
 *
 * Wait time is added only at completion, so it is not here.
 */
export function riderExpectedFareCup(ride: RiderExpectedFareInput): number {
  if (ride.final_fare_cup != null) return ride.final_fare_cup;
  const estimate = ride.estimated_fare_cup ?? 0;
  const discount = ride.discount_amount_cup ?? 0;
  return Math.max(estimate - discount, 0);
}

export interface RiderExpectedFareTrcInput extends RiderExpectedFareInput {
  final_fare_trc?: number | null;
  estimated_fare_trc?: number | null;
}

/**
 * TRC equivalent of `riderExpectedFareCup`, or null when the ride has no
 * TRC fare (cash and corporate rides).
 *
 * The discount is in CUP. Since 00655 a ride's TRC fare equals its CUP
 * fare, so this takes the same amount off; for an older row where the two
 * differ, the discount is scaled by the TRC/CUP ratio of the estimate, as
 * the booking screen does.
 */
export function riderExpectedFareTrc(ride: RiderExpectedFareTrcInput): number | null {
  if (ride.final_fare_trc != null) return ride.final_fare_trc;
  const estimateTrc = ride.estimated_fare_trc;
  if (estimateTrc == null) return null;
  const discount = ride.discount_amount_cup ?? 0;
  if (discount <= 0) return estimateTrc;
  const estimateCup = ride.estimated_fare_cup ?? 0;
  if (estimateCup <= 0) return Math.max(estimateTrc - discount, 0);
  const netCup = Math.max(estimateCup - discount, 0);
  return Math.round(estimateTrc * (netCup / estimateCup));
}

/**
 * Minimum DB shape needed to compute the rider-side "total cobrado":
 * the fare the wallet was actually debited for, including tip.
 *
 * Loose Pick<Ride, ...> typing so callers can pass partial rows
 * (e.g. trips lists that don't select all columns).
 */
export interface RiderChargedTotalInput extends RiderExpectedFareInput {
  tip_amount?: number | null;
}

/**
 * Canonical "total cobrado al cliente" in CUP.
 *
 * The `complete_ride_and_pay` RPC writes `rides.final_fare_cup` =
 * fare + wait_charge - discount, but does NOT include `tip_amount`
 * (tips are added later by the `add_tip` RPC, which only increments
 * `rides.tip_amount` and never rewrites `final_fare_cup`).
 *
 * However, when a rider adds a tip, the wallet IS debited for
 * `final_fare_cup + tip_amount`. So `final_fare_cup` alone is NOT a
 * truthful "total charged" — using it in receipts/UIs produces the
 * visible math fail `subtotal $200 + tip $20 = total $200`.
 *
 * This helper closes the gap by summing the tip back into the total.
 * Use it everywhere the rider sees "Total cobrado", "Total pagado",
 * or any equivalent label.
 *
 * Driver-side `tripNetEarnings()` already adds tip separately to the
 * driver's net (because the driver receives 100% of the tip on top
 * of their commission-net fare share), so this helper is rider-only.
 *
 * Before completion there is no `final_fare_cup`, and the fare falls back
 * to `riderExpectedFareCup` (the estimate minus the discount).
 */
export function riderChargedTotal(ride: RiderChargedTotalInput): number {
  const fare = riderExpectedFareCup(ride);
  const tip = ride.tip_amount ?? 0;
  return fare + tip;
}

/**
 * TRC equivalent for tricicoin-paid rides. Returns null when the ride
 * row has no TRC fields (typically cash/mixed/corporate rides).
 *
 * Mirrors `riderChargedTotal` so the wallet-debited TRC total matches
 * the CUP total shown.
 */
export interface RiderChargedTotalTrcInput extends RiderExpectedFareTrcInput {
  /** Tip in CUP (1 TRC = 1 CUP peg, so no conversion needed). */
  tip_amount?: number | null;
}

export function riderChargedTotalTrc(ride: RiderChargedTotalTrcInput): number | null {
  const fareTrc = riderExpectedFareTrc(ride);
  if (fareTrc == null) return null;
  const tip = ride.tip_amount ?? 0;
  return fareTrc + tip;
}

// ──────────────────────────────────────────────
// Tip suggestions (percentage of fare)
// ──────────────────────────────────────────────

/**
 * Suggested tip presets, as a percentage of the ride fare. Rendered as
 * chips in the post-ride tip UI (rider mobile + web). Single source of
 * truth so mobile and web always offer the same amounts.
 */
export const TIP_PERCENT_OPTIONS = [10, 15, 20] as const;

/**
 * Tip amount in whole TRC for a given fare and percentage. Since
 * 1 TRC = 1 CUP, the fare is in CUP and the result is in CUP/TRC.
 *
 * Returns 0 for any non-positive or non-finite input so a chip never
 * renders a bogus amount (e.g. before the fare has loaded).
 *
 *   tipAmountForPercent(2200, 15) → 330
 *   tipAmountForPercent(1000, 10) → 100
 *   tipAmountForPercent(0, 15)    → 0
 */
export function tipAmountForPercent(fareCup: number, pct: number): number {
  if (!Number.isFinite(fareCup) || !Number.isFinite(pct)) return 0;
  if (fareCup <= 0 || pct <= 0) return 0;
  return Math.round((fareCup * pct) / 100);
}
