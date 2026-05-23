-- ============================================================
-- BUG-pricing-audit (admin): driver_churn_risk earnings to NET
-- ============================================================
-- The `earnings_this_week` and `earnings_last_week` fields of the
-- `driver_churn_risk` view (last defined in 00199_advisors_critical_fixes)
-- summed `final_fare_cup` GROSS. Post-#146 the codebase convention is
-- that "earnings" means NET take-home for the driver:
--     fare - commission_amount + tip_amount
--
-- The driver app already follows this convention via the shared helper
-- `apps/driver/src/utils/tripNetEarnings.ts`, which prefers the snapshot
-- `commission_amount` (frozen at completion time) and falls back to a
-- 15% rate for legacy rides created before the snapshot pipeline (#147).
--
-- This migration aligns the view with that convention so churn alerts
-- and admin readouts of "earnings" use the same number the driver
-- sees in the dashboard.
--
-- Why a DROP + CREATE rather than CREATE OR REPLACE: the column list
-- of the view is unchanged, but per BUG-152 (migration 00199) the view
-- must be created `WITH (security_invoker = true)` so RLS on the
-- underlying tables applies to the caller, not the view owner.
-- `CREATE OR REPLACE` cannot toggle the security_invoker reloption
-- once set; the safe path is DROP + recreate. Per BUG-193 (00215) the
-- view also has `REVOKE SELECT FROM anon` — we re-apply that grant
-- below since DROP clears it.
--
-- The view is read-only and recomputed on every query; no data migration
-- needed. Existing admin pages (`apps/admin/src/app/...`) and the
-- service-level callers (`adminService.getDriverChurnRisk`,
-- `getHighChurnDrivers`) consume the same column names and types —
-- only the numeric value changes.
-- ============================================================

DROP VIEW IF EXISTS public.driver_churn_risk;

CREATE VIEW public.driver_churn_risk
WITH (security_invoker = true) AS
SELECT
  dp.id AS driver_profile_id,
  dp.user_id,
  u.full_name,
  dp.rating_avg,
  dp.total_rides_completed,
  dp.acceptance_rate,
  dp.is_online,
  dp.status,
  COALESCE(EXTRACT(days FROM (now() - (
    SELECT max(r.completed_at) FROM rides r
    WHERE r.driver_id = dp.id AND r.status = 'completed'
  ))), 999)::integer AS days_since_last_ride,

  -- BUG-pricing-audit: NET earnings (fare - commission + tip), aligned
  -- with `tripNetEarnings()` in apps/driver/src/utils/tripNetEarnings.ts.
  -- Commission preference order (same as the receipt PDF):
  --   1. `rps.commission_amount` snapshotted into ride_pricing_snapshots
  --      by `complete_ride_and_pay` — historical earnings stay frozen
  --      at the rate that was live when each ride completed.
  --   2. `round(r.final_fare_cup * 0.15)::integer` — fallback for
  --      legacy rides created before the snapshot pipeline landed.
  COALESCE((
    SELECT sum(
      r.final_fare_cup
        - COALESCE(rps.commission_amount, round(r.final_fare_cup * 0.15)::integer)
        + COALESCE(r.tip_amount, 0)
    )
    FROM rides r
    LEFT JOIN ride_pricing_snapshots rps
      ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
    WHERE r.driver_id = dp.id AND r.status = 'completed'
      AND r.completed_at > now() - interval '7 days'
  ), 0)::integer AS earnings_this_week,

  COALESCE((
    SELECT sum(
      r.final_fare_cup
        - COALESCE(rps.commission_amount, round(r.final_fare_cup * 0.15)::integer)
        + COALESCE(r.tip_amount, 0)
    )
    FROM rides r
    LEFT JOIN ride_pricing_snapshots rps
      ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
    WHERE r.driver_id = dp.id AND r.status = 'completed'
      AND r.completed_at >= now() - interval '14 days'
      AND r.completed_at <= now() - interval '7 days'
  ), 0)::integer AS earnings_last_week,

  LEAST(100, GREATEST(0,
    LEAST(40, COALESCE(EXTRACT(days FROM (now() - (
      SELECT max(r.completed_at) FROM rides r
      WHERE r.driver_id = dp.id AND r.status = 'completed'
    ))), 30)::integer * 2) +
    CASE
      WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20
      WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10
      ELSE 0
    END +
    CASE
      WHEN COALESCE(dp.acceptance_rate, 100) < 50 THEN 20
      WHEN COALESCE(dp.acceptance_rate, 100) < 70 THEN 10
      ELSE 0
    END
  )) AS churn_risk_score,

  CASE
    WHEN LEAST(100, GREATEST(0,
      LEAST(40, COALESCE(EXTRACT(days FROM (now() - (
        SELECT max(r.completed_at) FROM rides r
        WHERE r.driver_id = dp.id AND r.status = 'completed'
      ))), 30)::integer * 2) +
      CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END +
      CASE WHEN COALESCE(dp.acceptance_rate, 100) < 50 THEN 20 WHEN COALESCE(dp.acceptance_rate, 100) < 70 THEN 10 ELSE 0 END
    )) >= 50 THEN 'high'
    WHEN LEAST(100, GREATEST(0,
      LEAST(40, COALESCE(EXTRACT(days FROM (now() - (
        SELECT max(r.completed_at) FROM rides r
        WHERE r.driver_id = dp.id AND r.status = 'completed'
      ))), 30)::integer * 2) +
      CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END
    )) >= 25 THEN 'medium'
    ELSE 'low'
  END AS risk_level
FROM driver_profiles dp
LEFT JOIN users u ON u.id = dp.user_id
WHERE dp.status = 'approved';

COMMENT ON VIEW public.driver_churn_risk IS
  'BUG-152: created with security_invoker=true so caller RLS on driver_profiles applies. BUG-pricing-audit (00286): earnings_this_week and earnings_last_week now sum NET (fare - commission + tip), aligned with the driver app convention (tripNetEarnings helper).';

-- BUG-193 (00215): the view is admin-internal. Re-apply REVOKE since
-- DROP cleared the original grant. authenticated retains SELECT via
-- the public schema default.
REVOKE SELECT ON public.driver_churn_risk FROM anon;
