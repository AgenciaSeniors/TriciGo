/**
 * Fare split shares, as the server computes them.
 *
 * Since migration 00613, when the requester invites someone,
 * tg_ride_splits_guard ignores the share the app sends: the new invitee gets
 * floor(100 / n) % with 2 decimals, n = the requester + everyone already
 * invited + the new invitee, and every other share above that is lowered to
 * it. Shares never go up, so after a withdrawn invite the requester pays the
 * freed part. complete_ride_and_pay charges each accepted split
 * ROUND(fare × share / 100); the requester pays the rest, including the part
 * of any invite left unanswered.
 */

/** The share (%) each invitee gets when `participants` people split, requester included. */
export function equalSplitSharePct(participants: number): number {
  if (!Number.isFinite(participants) || participants < 1) return 100;
  return Math.floor(10000 / Math.floor(participants)) / 100;
}

/** What a split of `sharePct` % costs, rounded half up like Postgres ROUND(fare * share / 100). */
export function splitAmountTrc(fareTrc: number, sharePct: number | string): number {
  const fare = Math.max(0, Math.round(fareTrc));
  // In hundredths of a percent the product is an exact integer: no float drift.
  const hundredths = Math.round(Number(sharePct) * 100);
  if (!Number.isFinite(hundredths) || hundredths <= 0) return 0;
  return Math.floor((fare * hundredths + 5000) / 10000);
}

/** What the requester pays: the fare minus every invitee's part, counting pending invites as accepted. */
export function requesterShareTrc(
  fareTrc: number,
  splits: ReadonlyArray<{ share_pct: number | string }>,
): number {
  const fare = Math.max(0, Math.round(fareTrc));
  const invitees = splits.reduce((sum, s) => sum + splitAmountTrc(fare, s.share_pct), 0);
  return Math.max(0, fare - invitees);
}
