-- ============================================================
-- Migration 00387: NULL-safe authz in estimate_waypoint_surcharge_preview
--
-- Follow-up to 00386. The preview RPC's authz guard used:
--   IF NOT ( v_ride.customer_id = auth.uid() OR EXISTS(driver…) OR is_admin() )
-- When auth.uid() IS NULL, `customer_id = NULL` evaluates to NULL (not
-- false), so the whole OR is NULL, NOT(NULL) is NULL, and `IF NULL THEN`
-- is skipped → the function computes a result instead of returning
-- 'unauthorized'. Confirmed via a NULL-auth call (returned a value).
--
-- Not exploitable in practice: the RPC is GRANTed to `authenticated` only
-- (anon can't execute it), and an authenticated caller always has a
-- non-null auth.uid(). But a pricing gate must be NULL-safe — harden it
-- by rejecting NULL auth explicitly before the ownership check.
--
-- Applied to prod after explicit user authorization (security hardening
-- of the just-shipped 00386 preview RPC).
-- ============================================================

CREATE OR REPLACE FUNCTION public.estimate_waypoint_surcharge_preview(
  p_ride_id uuid,
  p_lat     double precision,
  p_lng     double precision
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_ride       rides%ROWTYPE;
  v_base       int;
  v_cur_sur    int;
  v_cur_extra  int;
  v_cand_sur   int;
  v_cand_extra int;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  -- authz: only the rider, the assigned driver, or an admin.
  -- `auth.uid() IS NULL` first so a NULL caller is rejected explicitly
  -- (otherwise `customer_id = NULL` is NULL, not false, and the guard
  -- would fall through — SQL three-valued logic).
  IF auth.uid() IS NULL OR NOT (
    v_ride.customer_id = auth.uid()
    OR EXISTS (SELECT 1 FROM driver_profiles WHERE id = v_ride.driver_id AND user_id = auth.uid())
    OR is_admin()
  ) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  SELECT COALESCE(pre_waypoints_total, total) INTO v_base
    FROM ride_pricing_snapshots
   WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;
  v_base := COALESCE(v_base, v_ride.estimated_fare_cup, 0);

  SELECT extra_road_m, surcharge_cup INTO v_cur_extra, v_cur_sur
    FROM public._waypoint_pricing(p_ride_id);
  SELECT extra_road_m, surcharge_cup INTO v_cand_extra, v_cand_sur
    FROM public._waypoint_pricing(p_ride_id, p_lat, p_lng);

  RETURN jsonb_build_object(
    'extra_distance_km', ROUND(GREATEST(v_cand_extra - v_cur_extra, 0) / 1000.0, 2),
    'extra_fare_cup',    GREATEST(v_cand_sur - v_cur_sur, 0),
    'new_total_cup',     v_base + v_cand_sur
  );
END;
$$;

COMMENT ON FUNCTION public.estimate_waypoint_surcharge_preview(uuid, double precision, double precision) IS
  '00386/00387: preview the fare impact of adding a stop (+$Y and new total) '
  'via the same _waypoint_pricing helper the trigger persists → preview == '
  'charge. 00387: NULL-safe authz (reject NULL auth.uid() explicitly).';
