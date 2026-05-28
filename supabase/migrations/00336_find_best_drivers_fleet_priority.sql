-- ============================================================
-- Migration 00336: find_best_drivers — fleet priority for corporate
--                  rides (PR-CORP-3, closes Gap 2 from corporate audit)
--
-- Context: pre-this-migration, when a corporate employee requested a
-- ride with payment_method='corporate', dispatch fired
-- `find_best_drivers` with NO awareness of the corporate_account_id.
-- Any nearby driver could accept — including drivers from competing
-- fleets. This broke the value prop of corporate `is_fleet_owner=true`
-- accounts that pay for an exclusive fleet of drivers.
--
-- Fix: extend `find_best_drivers` with optional `p_corporate_account_id`
-- param. When set AND the corp is `is_fleet_owner=true` AND the corp
-- has at least one `fleet_members.status='active'` row → HARD restrict
-- offers to drivers that ARE in that fleet. Otherwise, behavior is
-- unchanged (any nearby eligible driver).
--
-- Also update `dispatch_ride` to pass `v_ride.corporate_account_id`
-- to the new param.
--
-- Schema note: `fleet_members.driver_id` → `users.id` (NOT
-- `driver_profiles.id`). Verified 2026-05-27 via FK introspection.
-- The JOIN below uses `fm.driver_id = dp.user_id` accordingly.
--
-- Failure mode: if a fleet_owner corp has 0 active fleet_members,
-- the restriction is silently dropped (so service doesn't break for
-- corps mid-setup). The "warning, no fleet members" logic stays at
-- the admin UI level — fixing data inconsistency is out of scope.
--
-- Idempotent: CREATE OR REPLACE on the NEW signature. The OLD 12-param
-- signature is explicitly dropped first because Postgres treats
-- different arg counts as overloads — without the DROP both would
-- coexist and `dispatch_ride` calls would become ambiguous.
-- ============================================================

-- Drop the legacy 12-param signature so the new 13-param version
-- isn't an overload (mirrors mig 00263 drop_legacy_find_best_drivers_6param).
DROP FUNCTION IF EXISTS public.find_best_drivers(
  double precision, double precision, text, integer, integer, boolean,
  integer, text, numeric, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false,
  p_estimated_trip_distance_m integer DEFAULT NULL::integer,
  p_package_category text DEFAULT NULL::text,
  p_estimated_weight_kg numeric DEFAULT NULL::numeric,
  p_package_length_cm integer DEFAULT NULL::integer,
  p_package_width_cm integer DEFAULT NULL::integer,
  p_package_height_cm integer DEFAULT NULL::integer,
  p_corporate_account_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  distance_m double precision,
  match_score numeric,
  rating numeric,
  acceptance_rate numeric,
  composite double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_types vehicle_type[];
  v_is_long_trip BOOLEAN;
  v_use_fleet_restriction BOOLEAN := false;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  v_vehicle_types := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::vehicle_type]
  END;

  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  -- 00336 — Fleet priority gate: only restrict if corp exists, is
  -- a fleet_owner, AND has ≥1 active fleet_member. This three-way
  -- check ensures we don't accidentally lock out service for corps
  -- that flipped is_fleet_owner=true but haven't onboarded drivers
  -- yet.
  IF p_corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = p_corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_use_fleet_restriction;
  END IF;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id              AS dp_id,
      dp.user_id         AS dp_user_id,
      dp.match_score     AS dp_match_score,
      dp.rating_avg      AS dp_rating,
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
      AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      -- Cargo filters (B-G4 fail-CLOSED)
      AND (
        p_package_category IS NULL
        OR (
          v.accepted_cargo_categories IS NOT NULL
          AND array_length(v.accepted_cargo_categories, 1) > 0
          AND p_package_category = ANY(v.accepted_cargo_categories::text[])
        )
      )
      AND (
        p_estimated_weight_kg IS NULL
        OR (v.max_cargo_weight_kg IS NOT NULL AND v.max_cargo_weight_kg >= p_estimated_weight_kg)
      )
      AND (
        p_package_length_cm IS NULL
        OR (v.max_cargo_length_cm IS NOT NULL AND v.max_cargo_length_cm >= p_package_length_cm)
      )
      AND (
        p_package_width_cm IS NULL
        OR (v.max_cargo_width_cm IS NOT NULL AND v.max_cargo_width_cm >= p_package_width_cm)
      )
      AND (
        p_package_height_cm IS NULL
        OR (v.max_cargo_height_cm IS NOT NULL AND v.max_cargo_height_cm >= p_package_height_cm)
      )
      -- Geo + active city
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND (c.id IS NULL OR c.is_active = true)
      -- No double-booking (driver already on a ride)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      -- Driver preferences: max_distance_km opt-in cap
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      -- Driver preferences: accepts_long_trips opt-out
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
      -- 00336 — Fleet restriction: only drivers in the corp's fleet
      -- get offers when the gate evaluated to true above.
      AND (
        NOT v_use_fleet_restriction
        OR EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = p_corporate_account_id
            AND fm.driver_id = dp.user_id      -- ⚠️ fleet_members.driver_id → users.id
            AND fm.status = 'active'
        )
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
$function$;

COMMENT ON FUNCTION public.find_best_drivers(
  double precision, double precision, text, integer, integer, boolean,
  integer, text, numeric, integer, integer, integer, uuid
) IS
  '00336: adds p_corporate_account_id param + fleet restriction for fleet_owner corps. When the corp is a fleet_owner AND has ≥1 active fleet_member, restricts offers to drivers in that fleet (fm.driver_id = dp.user_id, fm.status=active). Otherwise unchanged.';


-- ── dispatch_ride: pass corporate_account_id to find_best_drivers ──
CREATE OR REPLACE FUNCTION public.dispatch_ride(
  p_ride_id uuid,
  p_radius_m integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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

  -- 00336: pass v_ride.corporate_account_id so find_best_drivers can
  -- enforce fleet restriction for fleet_owner corps.
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
    v_ride.estimated_distance_m,
    NULL,  -- p_package_category (delivery flow passes via separate path)
    NULL,  -- p_estimated_weight_kg
    NULL,  -- p_package_length_cm
    NULL,  -- p_package_width_cm
    NULL,  -- p_package_height_cm
    v_ride.corporate_account_id  -- 00336
  ) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s);
END;
$function$;

COMMENT ON FUNCTION public.dispatch_ride(uuid, integer) IS
  '00336: passes v_ride.corporate_account_id to find_best_drivers (13-param signature) so fleet restriction applies on corporate rides for fleet_owner corps.';
