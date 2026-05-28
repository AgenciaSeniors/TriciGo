-- ============================================================
-- Migration 00339: admin_get_online_fleet RPC
--                  (PR-MAP-1, closes Gap A + B from driver rendering audit)
--
-- Context: the existing admin live-map (apps/admin/src/app/live-map/page.tsx)
-- shows RIDES in active states (5 statuses), but there is NO admin
-- surface that shows the full FLEET of drivers online. Operations
-- can't answer "how many drivers do we have available right now?"
-- or "where are they?" at a glance.
--
-- This RPC returns ALL drivers currently online + approved + with
-- a current_location, joined to their active ride (if any) so the
-- admin map can color-code by state (idle / en route / in progress
-- / on break).
--
-- Auth: SECURITY DEFINER + role check (admin or super_admin).
-- Non-admin callers get 'Forbidden'.
--
-- No row limit — admins need to see ALL drivers. Cuba has ~9
-- registered drivers as of 2026-05-28 so we're not at scale risk yet;
-- if the fleet grows to 1000+ we can add server-side viewport
-- bounding box param.
--
-- Schema notes:
-- - `driver_profiles.current_location` is geography(Point, 4326)
-- - `driver_profiles.last_heartbeat_at` is timestamptz
-- - `users.full_name` and `users.phone` joined via driver_profiles.user_id
-- - active ride: status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
--
-- Idempotent: CREATE OR REPLACE.
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
    dp.current_heading,
    r.id AS current_ride_id,
    r.status AS current_ride_status
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN LATERAL (
    -- At most one active ride per driver (enforced by 00332 unique index)
    SELECT id, status
    FROM rides
    WHERE driver_id = dp.id
      AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
    ORDER BY created_at DESC
    LIMIT 1
  ) r ON true
  WHERE dp.is_online = true
    AND dp.status = 'approved'
    AND dp.current_location IS NOT NULL
  ORDER BY
    -- Sort: active rides first (driver_en_route / in_progress), then idle, then on_break
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
  '00339: returns all online + approved drivers with location + their active ride (if any). Admin/super_admin only. Used by /admin/fleet overview map.';

-- Grant explicit execute to authenticated (the auth check inside the
-- function does the actual gating, but granting to authenticated lets
-- the Supabase JS client invoke it via .rpc()).
GRANT EXECUTE ON FUNCTION public.admin_get_online_fleet() TO authenticated;
