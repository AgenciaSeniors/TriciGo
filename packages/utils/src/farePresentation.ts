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
 * Minimum DB shape needed to compute the rider-side "total cobrado":
 * the fare the wallet was actually debited for, including tip.
 *
 * Loose Pick<Ride, ...> typing so callers can pass partial rows
 * (e.g. trips lists that don't select all columns).
 */
export interface RiderChargedTotalInput {
  final_fare_cup?: number | null;
  estimated_fare_cup?: number | null;
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
 */
export function riderChargedTotal(ride: RiderChargedTotalInput): number {
  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup ?? 0;
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
export interface RiderChargedTotalTrcInput {
  final_fare_trc?: number | null;
  estimated_fare_trc?: number | null;
  /** Tip in CUP (1 TRC = 1 CUP peg, so no conversion needed). */
  tip_amount?: number | null;
}

export function riderChargedTotalTrc(ride: RiderChargedTotalTrcInput): number | null {
  const fareTrc = ride.final_fare_trc ?? ride.estimated_fare_trc;
  if (fareTrc == null) return null;
  const tip = ride.tip_amount ?? 0;
  return fareTrc + tip;
}
