-- ============================================================
-- 00479_admin_metrics_havana_tz.sql
--
-- Admin audit 2026-07-02, batch 2: the admin analytics RPCs anchored
-- "today" / day buckets / hour buckets to the Postgres server timezone
-- (UTC) instead of America/Havana. Cuba runs UTC-4/-5, so "Viajes hoy",
-- "Ingresos hoy", the revenue trend, and the peak-hours chart were all
-- shifted 4-5 hours from the real Cuban day.
--
-- Functions rewritten from their LIVE prod bodies (pg_get_functiondef,
-- fetched 2026-07-02) with ONLY the timezone anchoring changed, plus one
-- additive field:
--   * get_admin_dashboard_metrics gains `searching_rides` (rides waiting
--     for a driver right now) so the dashboard PulseMap can show a real
--     "Buscando" count -- the page previously derived it as
--     active_rides - active_rides = always 0. Return type changes, so
--     DROP + CREATE (pre-flight per CLAUDE.md: 42P13).
--
-- Timezone pattern: v_today = (now() AT TIME ZONE 'America/Havana')::date
-- (Havana calendar day), and a Havana-midnight timestamptz is recovered
-- with (v_today::timestamp AT TIME ZONE 'America/Havana'). DST-safe: the
-- tz database resolves the actual offset per date.
-- ============================================================

-- ── 1. get_admin_dashboard_metrics ──────────────────────────
-- Return type gains searching_rides → must drop first.
DROP FUNCTION IF EXISTS public.get_admin_dashboard_metrics();

CREATE FUNCTION public.get_admin_dashboard_metrics()
RETURNS TABLE(
  active_rides bigint,
  total_rides_today bigint,
  online_drivers bigint,
  total_revenue_today bigint,
  pending_verifications bigint,
  open_incidents bigint,
  searching_rides bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM rides
     WHERE status IN ('searching','accepted','driver_en_route','arrived_at_pickup','in_progress'))
      AS active_rides,
    (SELECT COUNT(*) FROM rides
     WHERE created_at >= v_day_start)
      AS total_rides_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE is_online = true)
      AS online_drivers,
    (SELECT COALESCE(SUM(final_fare_cup), 0) FROM rides
     WHERE status = 'completed' AND completed_at >= v_day_start)
      AS total_revenue_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE status IN ('pending_verification','under_review'))
      AS pending_verifications,
    (SELECT COUNT(*) FROM incident_reports
     WHERE status IN ('open','investigating'))
      AS open_incidents,
    (SELECT COUNT(*) FROM rides
     WHERE status = 'searching')
      AS searching_rides;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_dashboard_metrics() TO authenticated;

-- ── 2. get_platform_earnings ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_platform_earnings()
RETURNS TABLE(platform_balance bigint, earnings_today bigint, earnings_this_week bigint, earnings_this_month bigint, commission_rate numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Havana');
  v_week_start timestamptz := ((v_today - 7)::timestamp AT TIME ZONE 'America/Havana');
  v_month_start timestamptz := (date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Havana');
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
      AND r.completed_at >= v_day_start
    ), 0)::BIGINT AS earnings_today,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= v_week_start
    ), 0)::BIGINT AS earnings_this_week,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= v_month_start
    ), 0)::BIGINT AS earnings_this_month,

    COALESCE((
      SELECT (pc.value #>> '{}')::NUMERIC FROM platform_config pc WHERE pc.key = 'commission_rate'
    ), 0.15) AS commission_rate;
END;
$function$;

-- ── 3. get_peak_hours ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_peak_hours(p_days_back integer DEFAULT 30)
RETURNS TABLE(hour integer, avg_rides numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH hourly AS (
    SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE 'America/Havana')::INT AS hour,
           (r.created_at AT TIME ZONE 'America/Havana')::DATE AS day,
           COUNT(*) AS rides
    FROM rides r
    WHERE r.created_at >= ((((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp) AT TIME ZONE 'America/Havana')
    GROUP BY 1, 2
  )
  SELECT h.hour, ROUND(AVG(h.rides), 1) AS avg_rides FROM hourly h GROUP BY h.hour ORDER BY h.hour;
$function$;

-- ── 4. get_rides_by_day ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_rides_by_day(p_days_back integer DEFAULT 30)
RETURNS TABLE(day date, total bigint, completed bigint, canceled bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Havana')::date;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT d.day::DATE,
    COUNT(r.id) AS total,
    COUNT(r.id) FILTER (WHERE r.status = 'completed') AS completed,
    COUNT(r.id) FILTER (WHERE r.status = 'canceled') AS canceled,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0)::numeric AS revenue
  FROM generate_series(v_today - (p_days_back - 1), v_today, '1 day'::INTERVAL) AS d(day)
  LEFT JOIN rides r ON (r.created_at AT TIME ZONE 'America/Havana')::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
END;
$function$;

-- ── 5. get_rides_by_service_type ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_rides_by_service_type(p_days_back integer DEFAULT 30)
RETURNS TABLE(service_type text, count bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.service_type::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0)::numeric AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= v_window_start
  GROUP BY r.service_type
  ORDER BY revenue DESC;
END;
$function$;

-- ── 6. get_rides_by_payment_method ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_rides_by_payment_method(p_days_back integer DEFAULT 30)
RETURNS TABLE(payment_method text, count bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start timestamptz := (((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp AT TIME ZONE 'America/Havana');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    r.payment_method::TEXT,
    COUNT(r.id) AS count,
    COALESCE(SUM(r.final_fare_cup), 0)::numeric AS revenue
  FROM rides r
  WHERE r.status = 'completed'
    AND r.completed_at >= v_window_start
  GROUP BY r.payment_method
  ORDER BY revenue DESC;
END;
$function$;
