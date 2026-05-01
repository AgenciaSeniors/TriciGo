-- ============================================================
-- driver_profiles: recompute total_rides + total_rides_completed
-- ============================================================
-- Audit finding (Item 1, see PR #25 + this session): both counters
-- on driver_profiles drifted from the actual rides table:
--
--   driver           legacy_total_rides  maintained_completed  rides_table
--   --------------- ------------------- --------------------- ----------
--   Pedro Test Auto       200                  193                  3
--   Carlos Test Triciclo  120                  116                  0
--   María Test Moto        85                   82                  0
--   Eduardo Admin           0                    8                  6
--   Papa                    0                   30                 24
--
-- Two failure modes:
--   1. Seed/test rows had inflated counters baked in (Pedro/Carlos/María).
--   2. complete_ride_and_pay does an unconditional +1 on
--      total_rides_completed at the end of the RPC, with no idempotency
--      guard. If the function is called twice for the same ride
--      (retry, manual admin re-trigger), the counter double-counts.
--      Eduardo +2, Papa +6 above.
--
-- This migration ONLY recomputes from truth. The complete_ride_and_pay
-- idempotency bug is filed as a follow-up (see comment at the bottom).
-- ============================================================

WITH actual AS (
  SELECT driver_id, count(*)::int AS n
  FROM rides
  WHERE status = 'completed' AND driver_id IS NOT NULL
  GROUP BY driver_id
)
UPDATE driver_profiles dp
SET
  total_rides           = COALESCE(actual.n, 0),
  total_rides_completed = COALESCE(actual.n, 0),
  updated_at            = now()
FROM actual
WHERE actual.driver_id = dp.id
  AND (dp.total_rides <> COALESCE(actual.n, 0)
       OR dp.total_rides_completed <> COALESCE(actual.n, 0));

-- Drivers with NO completed rides also need to be zeroed if they
-- had a non-zero stale counter (Carlos/María case).
UPDATE driver_profiles dp
SET
  total_rides           = 0,
  total_rides_completed = 0,
  updated_at            = now()
WHERE NOT EXISTS (
  SELECT 1 FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'
)
AND (dp.total_rides <> 0 OR dp.total_rides_completed <> 0);

-- Verification (run after applying):
--   SELECT u.full_name AS driver,
--          dp.total_rides AS counter1,
--          dp.total_rides_completed AS counter2,
--          COALESCE(rc.n, 0) AS real_count
--   FROM driver_profiles dp
--   JOIN users u ON u.id = dp.user_id
--   LEFT JOIN (
--     SELECT driver_id, count(*)::int AS n FROM rides
--     WHERE status='completed' GROUP BY driver_id
--   ) rc ON rc.driver_id = dp.id
--   ORDER BY u.full_name;
--   -- expected: counter1 = counter2 = real_count for every row.

-- ============================================================
-- Follow-up filed: complete_ride_and_pay idempotency
-- ============================================================
-- The +1 increment at the end of complete_ride_and_pay should be
-- conditional on the ride.status transitioning from a non-completed
-- state to 'completed' for the FIRST time. Suggested fix:
--
--   IF v_ride.status <> 'completed' THEN
--     UPDATE driver_profiles SET total_rides_completed = ... + 1 ...;
--   END IF;
--
-- (v_ride.status is read at the top of the RPC under FOR UPDATE; the
-- existing precondition already enforces it must be in_progress or
-- arrived_at_destination, but if someone re-runs the RPC with admin
-- override after a refund-then-uncomplete, the increment fires again.)
-- Out of scope for this PR — recompute only.
-- ============================================================
