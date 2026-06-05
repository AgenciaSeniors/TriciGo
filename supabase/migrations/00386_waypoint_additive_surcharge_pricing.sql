-- ============================================================
-- Migration 00386: Add-stop pricing = "tarifa acordada + desvío"
--   (additive surcharge) with ONE source of truth for preview & charge.
--
-- Context / why:
--   When a rider adds a stop mid-ride, the route is re-traced through it
--   and the fare must INCREASE by the detour cost. The live function
--   recalc_ride_estimate_with_waypoints (00341 → rewritten in 00377)
--   RECOMPUTES the whole fare from service_type_configs (the dead base
--   config; the real prices come from pricing_rules) using straight-line
--   haversine. That can DROP or distort the price the rider already
--   agreed to (e.g. a triciclo whose contract is the pricing_rules min
--   2200 gets recomputed to ~1500 from base config → the fare DROPS when
--   a stop is added).
--
--   Business rule (confirmed by user 2026-06-05):
--     new_total       = fare_before_waypoints + detour_surcharge
--     detour_surcharge = ROUND(extra_road_km × per_km × surge)   (distance-only)
--     extra_road       = (len(pickup→stops→dropoff) − len(pickup→dropoff)) × 1.3
--   Never lowers the fare (surcharge ≥ 0). The "+$Y" preview == the
--   persisted increase because BOTH go through the same _waypoint_pricing()
--   helper (same geometry, same per_km, same ×1.3 road factor).
--
-- Design:
--   * fare_before_waypoints lives in ride_pricing_snapshots.pre_waypoints_total
--     (NOT on rides): the snapshot has a SELECT-only RLS policy (mig 00001
--     `rps_select`), so it is writable ONLY by SECURITY DEFINER functions →
--     tamper-proof. A rides column would be customer-writable (the
--     customer block of enforce_ride_update_columns does not protect
--     estimated_fare_cup), and pre_waypoints_total feeds snapshot.total
--     (= the money), so it must be tamper-proof.
--   * No itemized surcharge column on rides — the fare breakdown is
--     intentionally NON-itemized (project memory: the rider sees the new
--     TOTAL, not "base + per_km×d + …").
--   * per_km = COALESCE(driver_custom_rate_cup, service_type_configs.per_km)
--     — the same source the live recalc (00377) and the client preview
--     (estimateWaypointAddition) already use. This avoids porting
--     matchPricingRule()'s time-window/day matching into SQL (drift risk);
--     it is the standard per-km rate for the vehicle.
--   * complete_ride_and_pay & accept_ride_v2: UNCHANGED. They read
--     snapshot.total; we only change HOW total is (additively) updated.
--
-- Edge case (documented, accepted): a ride that already had a stop added
--   under the live 00377 (which overwrote snapshot.total via whole
--   recompute) will, at its first 00386 recalc, capture that 00377 value
--   as pre_waypoints_total instead of the pristine original. Only affects
--   rides mid-detour across the deploy boundary; impact is small.
--
-- NOT applied to prod yet (MCP guard). Apply after explicit authorization.
-- ============================================================

-- ── 1) Schema: tamper-proof base for the additive model ──
ALTER TABLE public.ride_pricing_snapshots
  ADD COLUMN IF NOT EXISTS pre_waypoints_total INTEGER;

COMMENT ON COLUMN public.ride_pricing_snapshots.pre_waypoints_total IS
  '00386: the GROSS estimate total BEFORE any waypoint was added (the price '
  'the rider originally agreed to). Captured once, the first time '
  'recalc_ride_estimate_with_waypoints runs for the ride. Additive add-stop '
  'pricing uses it as the base: total = pre_waypoints_total + detour_surcharge. '
  'Tamper-proof: ride_pricing_snapshots is SELECT-only via RLS (00001).';

-- ── 2) Shared helper: detour geometry + surcharge ──
-- Computes the surcharge for the CURRENTLY committed waypoints, optionally
-- PLUS a candidate point appended just before the dropoff (used by the
-- preview, before the stop is inserted). Single source of truth → the
-- preview and the persisted recalc compute the identical number.
CREATE OR REPLACE FUNCTION public._waypoint_pricing(
  p_ride_id    uuid,
  p_extra_lat  double precision DEFAULT NULL,
  p_extra_lng  double precision DEFAULT NULL
)
RETURNS TABLE(path_road_m int, extra_road_m int, surcharge_cup int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ride       rides%ROWTYPE;
  v_direct_m   numeric;
  v_path_m     numeric;
  v_extra_road numeric;
  v_per_km     numeric;
  v_surge      numeric;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  v_surge := COALESCE(NULLIF(v_ride.surge_multiplier, 0), 1.0);

  -- direct pickup → dropoff (haversine via geography)
  v_direct_m := ST_Length(
    ST_MakeLine(v_ride.pickup_location::geometry, v_ride.dropoff_location::geometry)::geography
  );

  -- full path: pickup → committed waypoints (ordered) → [candidate] → dropoff
  WITH pts AS (
    SELECT v_ride.pickup_location::geometry AS geom, 0 AS ord
    UNION ALL
    SELECT w.location::geometry, w.sort_order + 1
      FROM ride_waypoints w WHERE w.ride_id = p_ride_id
    UNION ALL
    SELECT ST_SetSRID(ST_MakePoint(p_extra_lng, p_extra_lat), 4326), 9000
      WHERE p_extra_lat IS NOT NULL AND p_extra_lng IS NOT NULL
    UNION ALL
    SELECT v_ride.dropoff_location::geometry, 9999
  )
  SELECT ST_Length(ST_MakeLine(geom ORDER BY ord)::geography) INTO v_path_m FROM pts;

  IF v_path_m IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  -- ×1.3 = estimateRoadDistance (packages/utils/src/geo.ts:131)
  v_extra_road := GREATEST(v_path_m - v_direct_m, 0) * 1.3;

  v_per_km := COALESCE(
    v_ride.driver_custom_rate_cup,
    (SELECT per_km_rate_cup FROM service_type_configs
       WHERE slug = v_ride.service_type AND is_active = true LIMIT 1)
  );
  IF v_per_km IS NULL THEN
    RETURN QUERY SELECT ROUND(v_path_m * 1.3)::int, ROUND(v_extra_road)::int, 0; RETURN;
  END IF;

  RETURN QUERY SELECT
    ROUND(v_path_m * 1.3)::int,
    ROUND(v_extra_road)::int,
    ROUND(v_extra_road / 1000.0 * v_per_km * v_surge)::int;
END;
$$;

COMMENT ON FUNCTION public._waypoint_pricing(uuid, double precision, double precision) IS
  '00386: detour geometry + additive surcharge for a ride''s committed '
  'waypoints (+ optional candidate before dropoff). surcharge = '
  'ROUND(extra_road_km × per_km × surge); extra_road = (path − direct) × 1.3. '
  'Shared by recalc_ride_estimate_with_waypoints (persist) and '
  'estimate_waypoint_surcharge_preview (preview) → preview == charge.';

-- ── 3) recalc: additive (base + surcharge), GROSS, never lowers the fare ──
CREATE OR REPLACE FUNCTION public.recalc_ride_estimate_with_waypoints(
  p_ride_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ride                 rides%ROWTYPE;
  v_snap                 ride_pricing_snapshots%ROWTYPE;
  v_path_road_m          int;
  v_extra_road_m         int;
  v_surcharge            int;
  v_base                 int;
  v_new_total            int;
  v_dur_s                int;
  v_commission_rate      numeric;
  v_corp_commission_rate numeric;
  v_commission_amount    int;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Only recalc for active rides (skip cancelled/completed)
  IF v_ride.status NOT IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  ) THEN RETURN; END IF;

  SELECT path_road_m, extra_road_m, surcharge_cup
    INTO v_path_road_m, v_extra_road_m, v_surcharge
  FROM public._waypoint_pricing(p_ride_id);

  -- Defensive: corrupt/empty geometry → don't touch the price
  IF v_path_road_m IS NULL OR v_path_road_m < 100 THEN RETURN; END IF;

  v_dur_s := ROUND((v_path_road_m / 1000.0) / 25.0 * 3600.0)::int;  -- 25 km/h urban

  SELECT * INTO v_snap FROM ride_pricing_snapshots
   WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;

  IF FOUND THEN
    -- Base = the original GROSS (pre-waypoints). On the first recalc
    -- pre_waypoints_total is NULL, so total still holds the original.
    v_base := COALESCE(v_snap.pre_waypoints_total, v_snap.total);
    v_new_total := v_base + v_surcharge;

    -- Commission snapshot on the new gross (mirror 00299/00377)
    SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
      FROM platform_config WHERE key = 'commission_rate';
    v_commission_rate := COALESCE(v_commission_rate, 0.15);
    IF v_ride.corporate_account_id IS NOT NULL THEN
      SELECT commission_percent / 100.0 INTO v_corp_commission_rate
        FROM corporate_accounts WHERE id = v_ride.corporate_account_id;
    END IF;
    IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
      v_commission_amount := ROUND(v_new_total * v_corp_commission_rate)::int;
    ELSE
      v_commission_amount := ROUND(v_new_total * v_commission_rate)::int;
    END IF;

    UPDATE ride_pricing_snapshots SET
      pre_waypoints_total = COALESCE(pre_waypoints_total, total),  -- capture original ONCE
      distance_m          = v_path_road_m,
      duration_s          = v_dur_s,
      subtotal            = v_new_total,
      total               = v_new_total,
      commission_amount   = v_commission_amount
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate';
  ELSE
    -- Legacy ride without an estimate snapshot: best-effort additive on the
    -- displayed estimate. complete_ride_and_pay uses its legacy path here.
    v_base := COALESCE(v_ride.estimated_fare_cup, 0);
    v_new_total := v_base + v_surcharge;
  END IF;

  -- Keep rides.estimated_* in sync for UI (GROSS; discount applied at
  -- completion). estimated_fare_cup is display only — snapshot.total is the
  -- money source of truth read by complete_ride_and_pay.
  UPDATE rides SET
    estimated_distance_m = v_path_road_m,
    estimated_duration_s = v_dur_s,
    estimated_fare_cup   = v_new_total,
    estimated_fare_trc   = v_new_total   -- 1:1 fallback (cup_to_trc done lazily)
  WHERE id = p_ride_id;
END;
$$;

COMMENT ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) IS
  '00386: additive add-stop pricing. total = pre_waypoints_total (original '
  'gross, captured once in the snapshot) + _waypoint_pricing surcharge. '
  'Never lowers the fare. Replaces the 00341/00377 whole-recompute (which '
  'used the dead base config + straight-line distance and could drop the '
  'agreed price). Called by trigger trg_recalc_fare_on_waypoint_change.';

-- ── 4) Preview RPC: same helper → "+$Y" == persisted increase ──
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

  -- authz: only the rider, the assigned driver, or an admin
  IF NOT (
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

  -- Delta of adding THIS stop on top of the existing waypoints (the "+$Y").
  -- new_total is the full additive total that the trigger will persist once
  -- the candidate is inserted as a committed waypoint.
  RETURN jsonb_build_object(
    'extra_distance_km', ROUND(GREATEST(v_cand_extra - v_cur_extra, 0) / 1000.0, 2),
    'extra_fare_cup',    GREATEST(v_cand_sur - v_cur_sur, 0),
    'new_total_cup',     v_base + v_cand_sur
  );
END;
$$;

COMMENT ON FUNCTION public.estimate_waypoint_surcharge_preview(uuid, double precision, double precision) IS
  '00386: preview the fare impact of adding a stop. Returns the incremental '
  'cost (+$Y) of THIS stop and the resulting new_total_cup, computed via the '
  'same _waypoint_pricing helper the trigger persists → preview == charge.';

GRANT EXECUTE ON FUNCTION public.estimate_waypoint_surcharge_preview(uuid, double precision, double precision)
  TO authenticated;
