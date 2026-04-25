-- ============================================================
-- Tier 7 Test 63 — Supabase advisors uncovered three live issues:
--
-- BUG-150: corporate_rides has an INSERT policy
--          `corporate_rides_insert` with WITH CHECK = true. Any
--          authenticated user could insert a corporate ride row
--          claiming any corporate_account_id, any ride_id, any
--          fare_trc — polluting corporate billing reports and
--          inflating corporate_account.current_month_spent (since
--          handle_corporate_ride_completion's accounting trigger
--          increments it). The legitimate inserter is the trigger
--          itself which runs as service_role and bypasses RLS.
--
-- BUG-151: paper_config (1 row), paper_trades (0), portfolio_snapshots
--          (0) are leftover tables from a paper-trading prototype
--          that share this Supabase instance. They have RLS
--          disabled, no FKs, no references in TriciGo code. Dropping.
--
-- BUG-152: driver_churn_risk and eligible_drivers were created
--          without the security_invoker flag, so they default to
--          SECURITY DEFINER and bypass RLS for anyone querying
--          them. After BUG-123 locked down driver_profiles, those
--          views became side-channels exposing match_score,
--          suspended_reason, is_financially_eligible,
--          negative_balance_since, etc. to any authenticated user.
--
-- Fix: tighten corporate_rides_insert; drop paper_*; recreate
-- the two views as security_invoker so they obey caller's RLS.
-- ============================================================

-- BUG-150
DROP POLICY IF EXISTS corporate_rides_insert ON public.corporate_rides;

CREATE POLICY corporate_rides_admin_insert
  ON public.corporate_rides
  FOR INSERT
  TO authenticated
  WITH CHECK (is_admin());

COMMENT ON POLICY corporate_rides_admin_insert ON public.corporate_rides IS
  'BUG-150: only admins can directly INSERT corporate_rides via PostgREST. The legitimate flow is the SECURITY DEFINER handle_corporate_ride_completion trigger, which runs as service_role and bypasses RLS regardless.';

-- BUG-151
DROP TABLE IF EXISTS public.paper_trades CASCADE;
DROP TABLE IF EXISTS public.portfolio_snapshots CASCADE;
DROP TABLE IF EXISTS public.paper_config CASCADE;

-- BUG-152: recreate views with security_invoker so RLS applies to caller
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
  COALESCE((
    SELECT sum(r.final_fare_cup) FROM rides r
    WHERE r.driver_id = dp.id AND r.status = 'completed'
      AND r.completed_at > now() - interval '7 days'
  ), 0)::integer AS earnings_this_week,
  COALESCE((
    SELECT sum(r.final_fare_cup) FROM rides r
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
  'BUG-152: recreated with security_invoker=true so caller RLS on driver_profiles applies. Customers no longer see fields like rating_avg, suspended_reason, etc. for arbitrary drivers.';

DROP VIEW IF EXISTS public.eligible_drivers;
CREATE VIEW public.eligible_drivers
WITH (security_invoker = true) AS
SELECT
  id, user_id, status, is_online, current_location, current_heading,
  rating_avg, total_rides, total_rides_completed, zone_id, approved_at,
  suspended_at, suspended_reason, created_at, updated_at,
  is_financially_eligible, negative_balance_since, match_score,
  acceptance_rate, total_rides_offered, custom_per_km_rate_cup,
  city_id, is_on_break, last_heartbeat_at
FROM driver_profiles
WHERE is_online = true
  AND (is_on_break IS NULL OR is_on_break = false)
  AND (is_financially_eligible IS NULL OR is_financially_eligible = true)
  AND last_heartbeat_at > now() - interval '3 minutes';

COMMENT ON VIEW public.eligible_drivers IS
  'BUG-152: recreated with security_invoker=true. Non-admin callers now only see their own driver_profile row through this view, matching the BUG-123 lockdown.';
