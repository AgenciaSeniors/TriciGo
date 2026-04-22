-- ============================================================
-- Migration 00141: dispatch_ride — dynamic offer TTL via platform_config
--
-- Replaces the hardcoded `interval '30 seconds'` in dispatch_ride with
-- a configurable value read from platform_config.offer_ttl_seconds.
--
-- Default stays at 30s so production behavior is unchanged. During
-- testing scenarios (e.g. single-device dev, slow network demos) we can
-- UPDATE platform_config SET value='120' WHERE key='offer_ttl_seconds'
-- to extend the acceptance window without another deploy.
-- ============================================================

-- ---- 1. Seed config key (idempotent) ----
INSERT INTO platform_config (key, value)
VALUES ('offer_ttl_seconds', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- 2. Drop prior signatures and re-create with dynamic TTL ----
DROP FUNCTION IF EXISTS public.dispatch_ride(uuid);
DROP FUNCTION IF EXISTS public.dispatch_ride(uuid, integer);

CREATE OR REPLACE FUNCTION public.dispatch_ride(
  p_ride_id   uuid,
  p_radius_m  integer DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride        rides%ROWTYPE;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_is_delivery boolean;
  v_count       int := 0;
  v_round       int;
  v_offer_ttl_s int;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');
  v_round := v_ride.dispatch_round + 1;

  -- Read offer TTL from platform_config (fallback 30s)
  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN
    v_offer_ttl_s := 30;
  END IF;

  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(v_pickup_lat, v_pickup_lng, v_ride.service_type, 10, p_radius_m, v_is_delivery) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE rides
    SET dispatch_round = v_round,
        last_dispatched_at = now()
  WHERE id = p_ride_id;

  -- On first round with zero matches, cancel immediately (no drivers in area).
  -- On later rounds with zero matches, DON'T cancel — the retry cron will
  -- escalate radius or give up after round 3.
  IF v_count = 0 AND v_round = 1 THEN
    UPDATE rides
      SET status = 'canceled',
          canceled_at = now(),
          cancellation_reason = 'no_drivers_available'
    WHERE id = p_ride_id AND status = 'searching';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'offers_created', v_count,
    'dispatch_round', v_round,
    'radius_m', p_radius_m,
    'offer_ttl_s', v_offer_ttl_s
  );
END;
$$;
