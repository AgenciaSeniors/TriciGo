-- ============================================================
-- Cancellation reputation (Phase 3/3) — make a low rider rating cost
-- MATCHING PRIORITY (the user-chosen consequence).
--
-- Driver side needs nothing here: a driver's rating_avg already weighs
-- 20% in find_best_drivers (00336), so a cancellation-driven star drop
-- already pushes them down the ranking automatically.
--
-- Rider side: there is no request queue today (dispatch is a simultaneous
-- broadcast). We add a SOFT gate: on the FIRST dispatch round, a rider
-- whose rating is below `low_rating_rider_threshold` gets a weaker
-- broadcast — fewer drivers and a smaller radius. The existing retry
-- loop (00126 retry_dispatch_expired_rides, rounds 2+) runs with the
-- full radius/limit, so a low-rating rider is never starved: they just
-- wait longer / reach fewer drivers up front. Set the threshold to 0
-- in platform_config to disable the gate.
-- ============================================================

CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride         rides%ROWTYPE;
  v_pickup_lat   double precision;
  v_pickup_lng   double precision;
  v_is_delivery  boolean;
  v_count        int := 0;
  v_round        int;
  v_offer_ttl_s  int;
  v_rider_rating numeric;
  v_threshold    numeric;
  v_limit        int := 10;
  v_eff_radius   int;
  v_gated        boolean := false;
BEGIN
  IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');
  v_round := v_ride.dispatch_round + 1;
  v_eff_radius := p_radius_m;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  -- ── Soft low-rating rider gate (first round only) ────────────
  v_threshold := get_platform_config_numeric('low_rating_rider_threshold', 3.0);
  IF v_round = 1 AND v_threshold > 0 THEN
    SELECT cp.rating_avg INTO v_rider_rating
      FROM customer_profiles cp WHERE cp.user_id = v_ride.customer_id;
    IF v_rider_rating IS NOT NULL AND v_rider_rating < v_threshold THEN
      v_gated := true;
      v_limit := GREATEST(1, get_platform_config_numeric('low_rating_rider_dispatch_limit', 5)::int);
      v_eff_radius := LEAST(p_radius_m,
        GREATEST(500, get_platform_config_numeric('low_rating_rider_radius_m', 3000)::int));
    END IF;
  END IF;

  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    v_limit,
    v_eff_radius,
    v_is_delivery,
    v_ride.estimated_distance_m,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    v_ride.corporate_account_id
  ) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s,
                            'low_rating_gated', v_gated);
END;
$function$;
