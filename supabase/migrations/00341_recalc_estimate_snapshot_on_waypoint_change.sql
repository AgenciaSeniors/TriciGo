-- ============================================================
-- Migration 00341: Recalc ride_pricing_snapshots 'estimate' + rides
--                  estimated_* on ride_waypoints INSERT/UPDATE/DELETE
--
-- Context: today the client app shows a fare delta preview when adding
-- a waypoint during an active ride, but the new fare is NEVER persisted.
-- `addWaypointToActiveRide` only does INSERT into `ride_waypoints` and
-- nothing else updates `rides.estimated_fare_cup` or the canonical
-- `ride_pricing_snapshots WHERE snapshot_type='estimate'` row.
--
-- Without this fix:
--   - Rider sees "+$120 nueva tarifa" preview (haversine est. client-side)
--   - DB has same `estimated_fare_cup` as before waypoint added
--   - `complete_ride_and_pay` (00340 + 00299 strict_parity) reads from
--     snapshot 'estimate' → cobra fare ORIGINAL sin waypoint
--   - Rider paga MENOS de lo prometido. Driver pierde ingresos del detour.
--
-- Fix: trigger on `ride_waypoints` recomputes pickup→waypoints→dropoff
-- distance via PostGIS (ST_MakeLine + ST_Length on geography) and:
--   1. UPDATEs the existing snapshot 'estimate' row (total + distance_m +
--      duration_s + subtotal + commission_amount)
--   2. UPDATEs rides.estimated_distance_m / estimated_duration_s /
--      estimated_fare_cup for UI consistency (apps display these fields)
--
-- complete_ride_and_pay needs ZERO changes — it already uses v_est.total
-- as the floor when strict_parity is active (00299 + 00340 line 177).
--
-- Approach: straight-line haversine (matches client-side estimator in
-- packages/utils/src/fareCalculator.ts using same 25 km/h speed). NOT
-- a real OSRM/Mapbox route — would require external HTTP from PG which
-- is not the right place. GPS actual_distance_m at completion is the
-- real upper bound; the estimate is just the contract floor.
--
-- Pricing formula mirrors:
--   - tg_rides_create_estimate_snapshot (00299) for initial snapshot
--   - complete_ride_and_pay (00340) for fare reconstruction
--   - packages/utils/src/fareCalculator.ts for client preview
--
-- Idempotent: trigger fires on every INSERT/UPDATE/DELETE on
-- ride_waypoints. Multiple rapid adds → multiple UPDATEs (last wins).
-- ============================================================

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
  v_svc                  RECORD;
  v_path_geom            geometry;
  v_total_dist_m         numeric;
  v_total_dur_s          numeric;
  v_speed_kmh            numeric := 25;  -- urban Cuba avg, matches client fareCalculator
  v_eff_per_km           numeric;
  v_raw_fare             int;
  v_base_fare            int;
  v_with_surge           int;
  v_final_est            int;
  v_commission_rate      numeric;
  v_corp_commission_rate numeric;
  v_commission_amount    int;
  v_existing_snapshot    boolean;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only recalc for active rides (skip cancelled/completed)
  IF v_ride.status NOT IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  ) THEN
    RETURN;
  END IF;

  -- Build LINESTRING: pickup → waypoints (sorted) → dropoff
  -- Using geometry then casting to geography for accurate haversine distance
  WITH points AS (
    SELECT v_ride.pickup_location::geometry AS geom, 0 AS ord
    UNION ALL
    SELECT w.location::geometry, w.sort_order + 1
      FROM ride_waypoints w
      WHERE w.ride_id = p_ride_id
    UNION ALL
    SELECT v_ride.dropoff_location::geometry, 9999
  ),
  ordered AS (
    SELECT geom FROM points ORDER BY ord
  )
  SELECT ST_MakeLine(geom) INTO v_path_geom FROM ordered;

  IF v_path_geom IS NULL THEN
    RETURN;
  END IF;

  -- ST_Length on geography returns meters (haversine)
  v_total_dist_m := ST_Length(v_path_geom::geography);

  -- Defensive: if computed distance is absurdly small (< original), skip.
  -- Could happen with corrupt waypoint coords.
  IF v_total_dist_m < 100 THEN
    RETURN;
  END IF;

  -- Duration via fixed urban speed (matches client estimator)
  v_total_dur_s := (v_total_dist_m / 1000.0) / v_speed_kmh * 3600.0;

  -- Pricing: replicates tg_rides_create_estimate_snapshot logic
  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc
  FROM public.service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_eff_per_km := COALESCE(v_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  v_raw_fare := ROUND(
    v_svc.base_fare_cup
    + (v_total_dist_m / 1000.0) * v_eff_per_km
    + (v_total_dur_s / 60.0) * v_svc.per_minute_rate_cup
  )::int;
  v_base_fare  := GREATEST(v_raw_fare, v_svc.min_fare_cup);
  v_with_surge := ROUND(v_base_fare * COALESCE(v_ride.surge_multiplier, 1.0))::int;
  v_final_est  := GREATEST(v_with_surge - COALESCE(v_ride.discount_amount_cup, 0), 0);

  -- Commission snapshot (preserve corp override if active)
  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
    FROM public.platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
      FROM public.corporate_accounts WHERE id = v_ride.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(v_final_est * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(v_final_est * v_commission_rate)::int;
  END IF;

  -- Update the canonical estimate snapshot if it exists (source of truth
  -- for complete_ride_and_pay strict_parity path)
  SELECT EXISTS(
    SELECT 1 FROM ride_pricing_snapshots
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate'
  ) INTO v_existing_snapshot;

  IF v_existing_snapshot THEN
    UPDATE ride_pricing_snapshots SET
      base_fare         = v_svc.base_fare_cup,
      per_km_rate       = v_eff_per_km,
      per_minute_rate   = v_svc.per_minute_rate_cup,
      distance_m        = ROUND(v_total_dist_m)::int,
      duration_s        = ROUND(v_total_dur_s)::int,
      subtotal          = v_final_est,
      total             = v_final_est,
      commission_rate   = COALESCE(v_corp_commission_rate, v_commission_rate),
      commission_amount = v_commission_amount,
      min_fare          = v_svc.min_fare_cup
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate';
  END IF;

  -- Also update rides.estimated_* so UI/legacy paths see consistent values.
  -- Skip estimated_fare_trc (computed via exchange rate downstream as needed).
  UPDATE rides SET
    estimated_distance_m = ROUND(v_total_dist_m)::int,
    estimated_duration_s = ROUND(v_total_dur_s)::int,
    estimated_fare_cup   = v_final_est,
    estimated_fare_trc   = v_final_est  -- 1:1 fallback (cup_to_trc done lazily)
  WHERE id = p_ride_id;
END;
$$;

COMMENT ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) IS
  '00341: recomputes ride distance/duration/fare from pickup→waypoints→dropoff '
  'via ST_MakeLine + haversine. Updates ride_pricing_snapshots WHERE snapshot_type='
  '''estimate'' (consumed by complete_ride_and_pay strict_parity) AND rides.estimated_*'
  'for UI consistency. Speed = 25 km/h to match client fareCalculator. Called by '
  'trigger trg_recalc_fare_on_waypoint_change.';

-- Trigger AFTER INSERT/UPDATE/DELETE on ride_waypoints
CREATE OR REPLACE FUNCTION public.tg_recalc_fare_on_waypoint_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ride_id uuid;
BEGIN
  v_ride_id := COALESCE(NEW.ride_id, OLD.ride_id);
  PERFORM public.recalc_ride_estimate_with_waypoints(v_ride_id);
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Defensive: recalc failure must never block waypoint mutation.
  RAISE WARNING 'tg_recalc_fare_on_waypoint_change failed for ride %: % %',
    v_ride_id, SQLSTATE, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_fare_on_waypoint_change ON public.ride_waypoints;
CREATE TRIGGER trg_recalc_fare_on_waypoint_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ride_waypoints
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_recalc_fare_on_waypoint_change();

COMMENT ON TRIGGER trg_recalc_fare_on_waypoint_change ON public.ride_waypoints IS
  '00341: keeps ride_pricing_snapshots estimate + rides.estimated_* in sync with '
  'the actual waypoints list. Fires AFTER on every mutation so the recalc sees the '
  'committed state. complete_ride_and_pay reads from the snapshot, so this trigger '
  'is the ONLY place that needs to know about waypoint pricing impact.';
