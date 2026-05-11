-- ============================================================
-- Migration 00263: add 'confort' to vehicle_type enum + strict
-- service-tier matching in find_best_drivers.
--
-- BACKGROUND
-- ----------
-- The driver onboarding screen (apps/driver/app/onboarding/
-- vehicle-info.tsx) already exposes 4 selectable tiers:
--   triciclo, moto, auto, confort
-- but until this migration the underlying enum only had three:
--   ('triciclo','moto','auto')
-- so the "Confort" tier was stored as vehicle.type='auto' and
-- distinguished only by an in-memory service_type_slug that
-- never reached the vehicles table. The matcher mapped every
-- ServiceTypeSlug starting with 'auto' (including 'auto_confort')
-- to vehicle_type='auto', so a rider booking Confort silently
-- got an Auto Standard driver, and a driver who onboarded as
-- Confort received Auto Standard offers — broken on both ends.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- 1. Adds 'confort' to the vehicle_type enum so the type can be
--    persisted in vehicles.type going forward. Existing rows
--    keep their current 'auto' value — drivers who want to
--    re-flag as Confort must re-edit their vehicle, which calls
--    the same update path with vehicle.type='confort'.
--
-- 2. Replaces find_best_drivers to map service tiers strictly:
--      auto_standard -> vehicle.type = 'auto'
--      auto_confort  -> vehicle.type = 'confort'
--    No overlap: a Confort booking will not be served by an Auto
--    driver (rider pays premium → premium fleet only), and an
--    Auto Standard booking will not be served by a Confort
--    driver (driver opted into premium → does not get básico
--    rates by surprise). Same for triciclo_* (all stay 'triciclo')
--    and moto_* (all stay 'moto').
--
--    Side effect: until at least one driver re-onboards with
--    vehicle.type='confort', auto_confort bookings will hit the
--    existing dispatch_ride "no drivers" fallback (cancels the
--    ride with reason='no_drivers_available'). Documented as
--    expected interim behaviour.
--
-- 3. The 'triciclo_cargo' service slug existed as a synonym for
--    cargo-on-triciclo (matched any triciclo driver who flagged
--    accepts_cargo=true). That still works — the
--    p_is_delivery filter on v.accepts_cargo is unchanged, and
--    every 'triciclo*' service maps to vehicle_type='triciclo'.
--
-- IDEMPOTENCY & ROLLBACK
-- ----------------------
-- - ADD VALUE IF NOT EXISTS makes the enum change safe to
--   re-apply.
-- - find_best_drivers is CREATE OR REPLACE; reverting means
--   re-applying 00262.
-- - No data is migrated. Reversal of the enum value itself is
--   not supported by PostgreSQL ALTER TYPE; removing 'confort'
--   later would require a manual rename-and-rebuild. Reflect
--   this in any rollback playbook.
--
-- RISK PROFILE
-- ------------
-- LOW — the additive enum change cannot break any existing
-- query or row. The find_best_drivers replacement is
-- strictly more restrictive on the auto branch (excludes
-- 'auto' from auto_confort matches, excludes 'confort' from
-- auto_standard matches), which under the current data (zero
-- drivers with vehicle.type='confort') reduces auto_confort
-- supply to zero — but the prior behaviour was *wrong*
-- (returning Auto drivers to Confort riders), so this is a
-- correctness fix, not a regression. UX-wise the rider sees
-- "no drivers available" instead of getting an Auto driver
-- pretending to be Confort.
-- ============================================================

-- 1. Enum value -------------------------------------------------
-- ADD VALUE cannot run inside a transaction in older PG, but
-- Supabase wraps migrations in autocommit-per-statement, so this
-- works as-is.
ALTER TYPE vehicle_type ADD VALUE IF NOT EXISTS 'confort';

-- 2. find_best_drivers with strict tier matching ----------------
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

  -- 00263: strict per-tier mapping. Each ServiceTypeSlug resolves
  -- to exactly one vehicle_type — Confort and Auto are now
  -- mutually exclusive at the matching layer.
  v_vehicle_type := CASE
    WHEN p_service_type LIKE 'triciclo%'         THEN 'triciclo'::vehicle_type
    WHEN p_service_type LIKE 'moto%'             THEN 'moto'::vehicle_type
    WHEN p_service_type = 'auto_confort'         THEN 'confort'::vehicle_type
    WHEN p_service_type LIKE 'auto%'             THEN 'auto'::vehicle_type
    WHEN p_service_type = 'mensajeria'           THEN NULL
    ELSE 'triciclo'::vehicle_type
  END;

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
      -- 00262 — driver preference: max_distance_km
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      -- 00262 — driver preference: accepts_long_trips
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
  '00263: strict per-tier matching — auto_confort maps to vehicle_type=confort, auto_* maps to vehicle_type=auto. Confort and Auto Standard are mutually exclusive in dispatch.';
