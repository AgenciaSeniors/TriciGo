-- ============================================================
-- Migration 00459: fix admin_get_online_fleet "column reference status is ambiguous"
--
-- Bug (since 00339, the function never worked): the function is
-- declared RETURNS TABLE(..., status driver_status, ..., driver_id uuid, ...).
-- In PL/pgSQL those OUT-parameter names become VARIABLES in scope inside
-- the body. The LATERAL subquery referenced `status` and `driver_id`
-- UNQUALIFIED:
--
--     SELECT id, status FROM rides
--     WHERE driver_id = dp.id AND status IN (...)
--
-- With plpgsql.variable_conflict = error (the default), the unqualified
-- `status` (and `driver_id`) collide between the OUT-param variable and the
-- rides column -> ERROR 42702 "column reference \"status\" is ambiguous"
-- at plan time. So /admin live-map's drivers layer always failed, regardless
-- of data or RLS. (Confirmed: the identical query run as raw SQL — no plpgsql
-- variables in scope — is clean; only inside the function does it error.)
--
-- Fix: fully qualify every column ref inside the LATERAL subquery
-- (rides.id / rides.status / rides.driver_id / rides.created_at) so they
-- can never be read as plpgsql variables. Also add `#variable_conflict
-- use_column` as a belt-and-suspenders directive (any future unqualified
-- name resolves to the column, never a variable).
--
-- Body otherwise byte-for-byte identical to the live 00339 definition
-- (admin gate, SELECT list, JOINs, WHERE, ORDER BY CASE all unchanged).
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
    dp.current_heading,
    r.id AS current_ride_id,
    r.status AS current_ride_status
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN LATERAL (
    -- At most one active ride per driver (enforced by 00332 unique index).
    -- All columns qualified with `rides.` so they cannot be parsed as the
    -- function's OUT-param variables (status / driver_id).
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
    -- Sort: active rides first (arrived/in_progress), then en_route, then idle, then on_break
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
  '00459: returns all online + approved drivers with location + their active ride (if any). Admin/super_admin only. Used by /admin/live-map drivers layer. Fixes 00339 plpgsql variable/column ambiguity (status, driver_id).';

GRANT EXECUTE ON FUNCTION public.admin_get_online_fleet() TO authenticated;
