export const RIDE_CONFIG = {
  MIN_DISTANCE_M: 200,
  SEARCH_TIMEOUT_MS: 120_000,
  /** Maximum total search time before final cancellation (5 min) */
  SEARCH_MAX_TOTAL_MS: 300_000,
  /** Number of search retry rounds (expanding message each round) */
  SEARCH_RETRY_ROUNDS: 2,
  FARE_ESTIMATE_TTL_MS: 300_000,
  MAX_WAYPOINTS: 3,
  MAX_TIP_AMOUNT: 100_000,
  POSITION_TIMEOUT_MS: 30_000,
  MAX_RECHARGE_AMOUNT: 50_000,
  DRIVER_NOT_MOVING_THRESHOLD_M: 50,
  DRIVER_NOT_MOVING_TIMEOUT_MS: 300_000,
} as const;
