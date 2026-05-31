// ============================================================
// TriciGo — Shared ride configuration
// ------------------------------------------------------------
// Single source of truth for ride booking/tracking constants,
// consumed by BOTH the mobile client (apps/client) and the web
// app (apps/web). The mobile config (apps/client/src/config/ride.ts)
// re-exports from here so existing native call sites stay valid.
// ============================================================

export const RIDE_CONFIG = {
  MIN_DISTANCE_M: 200,
  /** Interval of the persistent-search loop (reassurance toast + radius
   *  nudge). The search is NEVER auto-canceled — the server keeps
   *  dispatching and the rider cancels manually if they want. */
  SEARCH_TIMEOUT_MS: 120_000,
  /** First rounds that show the "expanding search" toast + widen radius. */
  SEARCH_RETRY_ROUNDS: 2,
  /** Radius progression for retry rounds (initial creation uses 5000m) */
  SEARCH_RADIUS_PROGRESSION: [8000, 12000],
  FARE_ESTIMATE_TTL_MS: 300_000,
  MAX_WAYPOINTS: 3,
  MAX_TIP_AMOUNT: 100_000,
  POSITION_TIMEOUT_MS: 30_000,
  MAX_RECHARGE_AMOUNT: 50_000,
  DRIVER_NOT_MOVING_THRESHOLD_M: 50,
  DRIVER_NOT_MOVING_TIMEOUT_MS: 300_000,
} as const;
