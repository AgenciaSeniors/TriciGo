-- ============================================================
-- Migration 00148: fix JSONB→numeric cast in get_driver_earnings_by_zone
--
-- The function reads `commission_rate` from platform_config with:
--   SELECT COALESCE((value)::numeric, 0.15) INTO v_commission ...
-- `value` is JSONB, and PostgreSQL cannot cast JSONB directly to
-- numeric — it raises 22023 "cannot cast jsonb string to type numeric".
-- Result: the Ganancias tab's zone breakdown chart gets a 400 from
-- the RPC and silently renders empty.
--
-- The exact same antipattern was fixed inside complete_ride_and_pay
-- where the code was updated to `(value #>> '{}')::NUMERIC` with the
-- comment "extract JSONB scalar as text before casting to NUMERIC".
-- This migration applies the same fix here.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_driver_earnings_by_zone(
  p_driver_id uuid,
  p_start timestamp with time zone,
  p_end timestamp with time zone
)
RETURNS TABLE(zone_id uuid, zone_name text, trip_count integer, total_fare_cup bigint, total_earnings_cup bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_commission numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles
    WHERE id = p_driver_id AND user_id = auth.uid()
  ) AND NOT is_admin() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- FIX: extract JSONB scalar as text before casting to NUMERIC
  SELECT COALESCE((value #>> '{}')::numeric, 0.15)
  INTO v_commission
  FROM platform_config WHERE key = 'commission_rate' LIMIT 1;

  IF v_commission IS NULL THEN
    v_commission := 0.15;
  END IF;

  RETURN QUERY
  SELECT
    z.id,
    z.name,
    count(r.id)::int,
    COALESCE(sum(r.final_fare_cup), 0)::bigint,
    COALESCE(sum((r.final_fare_cup * (1.0 - v_commission))::int), 0)::bigint
  FROM rides r
  JOIN zones z ON z.is_active
    AND ST_Contains(z.boundary::geometry, r.pickup_location::geometry)
  WHERE r.driver_id = p_driver_id
    AND r.status = 'completed'
    AND r.completed_at BETWEEN p_start AND p_end
  GROUP BY z.id, z.name
  HAVING count(r.id) > 0
  ORDER BY total_earnings_cup DESC
  LIMIT 5;
END;
$function$;
