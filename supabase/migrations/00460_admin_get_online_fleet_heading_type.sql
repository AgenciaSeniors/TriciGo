-- ============================================================
-- Migration 00460: admin_get_online_fleet — fix current_heading type mismatch
--
-- Follow-up to 00459. After fixing the plpgsql status/driver_id ambiguity,
-- a SECOND latent bug in the original 00339 definition surfaced (it had been
-- masked because the parse-time ambiguity error fired first):
--
--   RETURNS TABLE(..., current_heading integer, ...)
--   but driver_profiles.current_heading is `numeric`
--   -> ERROR 42804 "structure of query does not match function result type"
--
-- Fix: cast dp.current_heading::integer in the SELECT. It is the only column
-- whose source type differed from the declared RETURNS TABLE type (the other
-- 12 were verified to match). Heading is 0-359 degrees, so integer is fine.
--
-- Verified in prod: as an authenticated admin the function now returns
-- without error. Body otherwise identical to 00459. CREATE OR REPLACE.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_get_online_fleet()
RETURNS TABLE (
  driver_id uuid,
  user_id uuid,
  full_name text,
  phone text,
  status driver_status,
  is_online boolean,
  is_on_break boolean,
  last_heartbeat_at timestamptz,
  lat double precision,
  lng double precision,
  current_heading integer,
  current_ride_id uuid,
  current_ride_status ride_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  -- Admin gate
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin
  FROM users WHERE id = auth.uid();

  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    dp.id AS driver_id,
    dp.user_id,
    u.full_name,
    u.phone,
    dp.status,
    dp.is_online,
    dp.is_on_break,
    dp.last_heartbeat_at,
    ST_Y(dp.current_location::geometry) AS lat,
    ST_X(dp.current_location::geometry) AS lng,
    dp.current_heading::integer,
    r.id AS current_ride_id,
    r.status AS current_ride_status
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN LATERAL (
    -- All columns qualified with `rides.` so they cannot be parsed as the
    -- function's OUT-param variables (status / driver_id). See 00459.
    SELECT rides.id, rides.status
    FROM rides
    WHERE rides.driver_id = dp.id
      AND rides.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
    ORDER BY rides.created_at DESC
    LIMIT 1
  ) r ON true
  WHERE dp.is_online = true
    AND dp.status = 'approved'
    AND dp.current_location IS NOT NULL
  ORDER BY
    CASE
      WHEN r.status IN ('arrived_at_pickup','in_progress','arrived_at_destination') THEN 1
      WHEN r.status IN ('accepted','driver_en_route') THEN 2
      WHEN dp.is_on_break THEN 4
      ELSE 3
    END,
    u.full_name;
END;
$function$;

COMMENT ON FUNCTION public.admin_get_online_fleet() IS
  '00460: online+approved drivers with location + active ride. Admin only. Used by /admin/live-map drivers layer. Fixes 00339 plpgsql ambiguity (status/driver_id) AND current_heading numeric->integer cast.';

GRANT EXECUTE ON FUNCTION public.admin_get_online_fleet() TO authenticated;
