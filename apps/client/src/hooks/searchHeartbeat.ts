/**
 * Persistent-search heartbeat rule.
 *
 * `cleanup_orphan_searching_rides` (cron, every minute) cancels any ride whose
 * `searching_seen_at` is older than `searching_abandon_seconds` — 600s in
 * production. The rider app is supposed to keep that column fresh by calling
 * `touch_searching_ride` while the search screen is up.
 *
 * Kept as a plain function so it is reachable by tests: apps/client has no
 * React Native renderer, so a rule living inside a hook body cannot be tested.
 */

// Every beat is an UPDATE on `rides`, which the ALL-COLUMNS `audit_rides`
// trigger records. The watcher that drives this ticks every 3s, so beating on
// each tick would write ~20 audit rows/min per waiting rider for no benefit.
// 30s is the cadence documented in migration 00269 and in
// rideService.touchSearchingRide, and still leaves ~20 beats of margin against
// the 600s abandon window.
export const SEARCH_HEARTBEAT_MS = 30_000;

/**
 * Should the heartbeat fire on this watcher tick?
 *
 * Only while the rider is actually waiting for a driver: once the trip is
 * under way there is nothing to keep alive, and the reaper only looks at
 * `searching` rides anyway.
 */
export function shouldSendSearchHeartbeat(
  flowStep: string,
  lastBeatAt: number,
  now: number,
): boolean {
  return flowStep === 'searching' && now - lastBeatAt >= SEARCH_HEARTBEAT_MS;
}
