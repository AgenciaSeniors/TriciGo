-- ============================================================
-- BUG-133: four admin report RPCs are SECURITY DEFINER, granted
-- EXECUTE to authenticated (and anon), with NO is_admin() check:
--   - get_platform_earnings()        — leaks platform_revenue
--                                      balance + earnings_today /
--                                      _week / _month + commission_rate
--   - get_rides_by_day()             — daily ride counts + revenue
--   - get_rides_by_payment_method()  — same, sliced by payment method
--   - get_rides_by_service_type()    — same, sliced by service type
--
-- Effect: any authenticated user (or anonymous via supabase.rpc())
-- can pull commercially sensitive figures. Competitors, journalists,
-- a curious driver — all see the same revenue feed admin sees.
--
-- get_driver_earnings_by_zone already has the right pattern (caller
-- must own the driver_profile or be admin) so it stays as-is.
--
-- Fix: add is_admin() gate at the top of each function. Pattern
-- mirrors BUG-130/131/132. Returns NULL/empty if the caller is
-- not admin, which produces a clean fail-closed shape on the
-- admin UI side without crashing the page.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_platform_earnings()
RETURNS TABLE(platform_balance bigint, earnings_today bigint, earnings_this_week bigint, earnings_this_month bigint, commission_rate numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE((
      SELECT wa.balance FROM wallet_accounts wa
      WHERE wa.user_id = '00000000-0000-0000-0000-000000000001'
      AND wa.account_type = 'platform_revenue'
    ), 0)::BIGINT AS platform_balance,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= CURRENT_DATE
    ), 0)::BIGINT AS earnings_today,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= CURRENT_DATE - 7
    ), 0)::BIGINT AS earnings_this_week,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= date_trunc('month', CURRENT_DATE)
    ), 0)::BIGINT AS earnings_this_month,

    COALESCE((
      SELECT (pc.value #>> '{}')::NUMERIC FROM platform_config pc WHERE pc.key = 'commission_rate'
    ), 0.15) AS commission_rate;
END;
$$;

COMMENT ON FUNCTION public.get_platform_earnings() IS
  'BUG-133: now requires the caller (auth.uid()) to be admin/super_admin.';


CREATE OR REPLACE FUNCTION public.get_rides_by_day(p_days_back integer DEFAULT 30)
RETURNS TABLE(day date, total bigint, completed bigint, canceled bigint, revenue numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT d.day::DATE,
    COUNT(r.id) AS total,
    COUNT(r.id) FILTER (WHERE r.status = 'completed') AS completed,
    COUNT(r.id) FILTER (WHERE r.status = 'canceled') AS canceled,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM generate_series(CURRENT_DATE - (p_days_back - 1), CURRENT_DATE, '1 day'::INTERVAL) AS d(day)
  LEFT JOIN rides r ON r.created_at::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
END;
$$;

COMMENT ON FUNCTION public.get_rides_by_day(integer) IS
  'BUG-133: now requires the caller (auth.uid()) to be admin/super_admin.';


CREATE OR REPLACE FUNCTION public.get_rides_by_payment_method(p_days_back integer DEFAULT 30)
RETURNS TABLE(payment_method text, count bigint, revenue numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.payment_method::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0) AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= CURRENT_DATE - p_days_back
  GROUP BY r.payment_method
  ORDER BY revenue DESC;
END;
$$;

COMMENT ON FUNCTION public.get_rides_by_payment_method(integer) IS
  'BUG-133: now requires the caller (auth.uid()) to be admin/super_admin.';


CREATE OR REPLACE FUNCTION public.get_rides_by_service_type(p_days_back integer DEFAULT 30)
RETURNS TABLE(service_type text, count bigint, revenue numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.service_type::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0) AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= CURRENT_DATE - p_days_back
  GROUP BY r.service_type
  ORDER BY revenue DESC;
END;
$$;

COMMENT ON FUNCTION public.get_rides_by_service_type(integer) IS
  'BUG-133: now requires the caller (auth.uid()) to be admin/super_admin.';
