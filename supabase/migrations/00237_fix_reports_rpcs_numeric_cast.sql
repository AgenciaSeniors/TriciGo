-- ============================================================
-- Fix: admin Reports page showed "Error al cargar reportes"
-- ============================================================
-- 3 of the 8 RPCs Promise.all'd by /reports crashed with:
--   ERROR 42804: structure of query does not match function result type
--   DETAIL: Returned type bigint does not match expected type numeric
--
-- Cause: rides.final_fare_cup is INTEGER, so SUM() yields BIGINT, but
-- each function declared `revenue numeric` in its RETURNS TABLE clause.
-- Postgres rejects the mismatch at runtime — for any admin caller that
-- passes the is_admin() gate, the function body crashes on RETURN QUERY.
--
-- Fix: cast SUM(...)::numeric in the three affected RPCs. No change to
-- the function signature, gates, or call sites — pure type alignment.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_rides_by_day(p_days_back integer DEFAULT 30)
RETURNS TABLE(day date, total bigint, completed bigint, canceled bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  FROM generate_series(CURRENT_DATE - (p_days_back - 1), CURRENT_DATE, '1 day'::INTERVAL) AS d(day)
  LEFT JOIN rides r ON r.created_at::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rides_by_service_type(p_days_back integer DEFAULT 30)
RETURNS TABLE(service_type text, count bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
    AND r.completed_at >= CURRENT_DATE - p_days_back
  GROUP BY r.service_type
  ORDER BY revenue DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rides_by_payment_method(p_days_back integer DEFAULT 30)
RETURNS TABLE(payment_method text, count bigint, revenue numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
    AND r.completed_at >= CURRENT_DATE - p_days_back
  GROUP BY r.payment_method
  ORDER BY revenue DESC;
END;
$function$;
