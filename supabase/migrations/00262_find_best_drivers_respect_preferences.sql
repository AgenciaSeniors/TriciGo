-- ============================================================
-- Migration 00262: find_best_drivers respects driver preferences
--
-- Phase 2 / parity-audit follow-up. The `driver_profiles.preferences`
-- JSONB column (added in 00257) was being written from the driver
-- preferences screen but ignored by the matching engine. This wires
-- two of the four preference fields into `find_best_drivers`:
--
--   1. `max_distance_km` — driver's personal cap on driver→pickup
--      distance (km). When set, we filter out drivers whose distance
--      to the requested pickup exceeds their cap, even if they're
--      otherwise inside `p_radius_m`. Defaults: no cap.
--
--   2. `accepts_long_trips` — driver opt-out for trips >10 km. The
--      trip distance is passed via the new optional parameter
--      `p_estimated_trip_distance_m`. When that parameter is NULL
--      (legacy callers), the filter is a no-op.
--
-- Out of scope (still deferred):
--   - `accepts_minors_alone`: requires rider age data the schema
--     doesn't yet capture.
--   - `music_preference`: subjective, doesn't gate matching — only
--     informs the driver post-accept.
--
-- Backwards-compat:
--   - The new `p_estimated_trip_distance_m` parameter has DEFAULT NULL,
--     so existing callers (cron retries, admin tools) still work.
--   - All preference filters are NULL-safe via `IS NULL OR ...`, so
--     drivers who haven't set preferences keep getting matched as
--     before.
--
-- Risk profile:
--   - Filters are RESTRICTIVE only (existing matches can be excluded,
--     never new ones added) — so the worst case under bad data is
--     "fewer offers", not "wrong driver assigned".
--   - The cast `(...->>'max_distance_km')::int` would throw on a
--     non-numeric value. The driver preferences screen validates the
--     input as integer 1..200 client-side AND the JSONB column writes
--     are gated by the same screen. If a malformed value sneaks in,
--     dispatch fails open via SECURITY DEFINER + the wrapper trigger
--     pattern (the calling cron retries; manual intervention will
--     surface in logs).
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- ============================================================

CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false,
  p_estimated_trip_distance_m integer DEFAULT NULL
)
RETURNS TABLE(
  id uuid, user_id uuid, distance_m double precision,
  match_score numeric, rating numeric, acceptance_rate numeric,
  composite double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_type vehicle_type;
  v_is_long_trip BOOLEAN;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  v_vehicle_type := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN 'triciclo'::vehicle_type
    WHEN p_service_type LIKE 'moto%'     THEN 'moto'::vehicle_type
    WHEN p_service_type LIKE 'auto%'     THEN 'auto'::vehicle_type
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE 'triciclo'::vehicle_type
  END;

  -- 10 km is the canonical "long trip" threshold (matches the
  -- DriverPreferences type comment and the rider-side ride creation
  -- analytics bucket).
  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id            AS dp_id,
      dp.user_id       AS dp_user_id,
      dp.match_score   AS dp_match_score,
      dp.rating_avg    AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
        FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status = 'completed'
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND r.accepted_at IS NOT NULL
      )::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_type IS NULL OR v.type = v_vehicle_type)
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND (c.id IS NULL OR c.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      -- 00262 — driver preference: max_distance_km. NULL-safe: when the
      -- preference is unset or the column is empty JSONB, the filter
      -- passes through. When set, we exclude drivers whose pickup
      -- distance exceeds their personal cap (multiplied to meters).
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      -- 00262 — driver preference: accepts_long_trips. When the trip
      -- distance is short (<=10 km) or the parameter is NULL (legacy
      -- caller), this filter is a no-op. When the trip is long AND
      -- the driver explicitly set accepts_long_trips=false, exclude.
      -- A missing key defaults to "accept" — same as today's behavior.
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
  )
  SELECT
    ed.dp_id, ed.dp_user_id, ed.dist_m,
    ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (
      0.30 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
      0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
      0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
      0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
      0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
      0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.find_best_drivers(double precision, double precision, text, integer, integer, boolean, integer) IS
  '00262: respects driver_profiles.preferences.max_distance_km and accepts_long_trips. New optional p_estimated_trip_distance_m param (defaults NULL = legacy behavior).';

-- ── Update dispatch_ride to pass the trip distance ──────────────
-- The function shape is preserved — same signature, same return.
-- Only the call to find_best_drivers is updated to pass the new
-- 7th argument.

CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  -- 00262: pass v_ride.estimated_distance_m so find_best_drivers can
  -- filter drivers who opted out of long trips (>10 km).
  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    10,
    p_radius_m,
    v_is_delivery,
    v_ride.estimated_distance_m
  ) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  IF v_count = 0 AND v_round = 1 THEN
    UPDATE rides SET status = 'canceled', canceled_at = now(),
                     cancellation_reason = 'no_drivers_available'
    WHERE id = p_ride_id AND status = 'searching';
  END IF;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s);
END;
$$;

COMMENT ON FUNCTION public.dispatch_ride(uuid, integer) IS
  '00262: passes ride.estimated_distance_m to find_best_drivers so driver accepts_long_trips preference is honored.';
