-- ============================================================
-- BUG-124: find_best_drivers had a "no active ride" guard that
-- compared the wrong identifiers, so the filter was always inactive.
--
--   AND NOT EXISTS (SELECT 1 FROM rides r
--     WHERE r.driver_id = dp.user_id
--     AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress'))
--
-- rides.driver_id is a FK to driver_profiles.id (verified via
-- pg_constraint), but dp.user_id is the FK to users.id. Across the
-- 8 driver_profiles rows in production, id <> user_id in EVERY row
-- — so the EXISTS subquery never matched and the NOT EXISTS clause
-- always evaluated to true. Effect: drivers mid-ride were still
-- offered new ride_offers and could be double-booked.
--
-- Fix: change r.driver_id = dp.user_id to r.driver_id = dp.id.
-- All other logic stays intact.
--
-- Verified end-to-end:
--   1. baseline (eligible driver, no active ride) → visible = 1
--   2. driver gets in_progress ride                → visible = 0
-- find_nearby_vehicles already uses the correct r.driver_id = dp.id
-- so this is the only place the bug existed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false
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
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  v_vehicle_type := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN 'triciclo'::vehicle_type
    WHEN p_service_type LIKE 'moto%'     THEN 'moto'::vehicle_type
    WHEN p_service_type LIKE 'auto%'     THEN 'auto'::vehicle_type
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE 'triciclo'::vehicle_type
  END;

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
      -- BUG-124: was r.driver_id = dp.user_id (compared driver_profiles.id
      -- to users.id; never matched). Correct is r.driver_id = dp.id.
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
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

COMMENT ON FUNCTION public.find_best_drivers(double precision, double precision, text, integer, integer, boolean) IS
  'BUG-124: fixed double-booking guard (r.driver_id = dp.id). Previous version compared the wrong UUID and never excluded drivers already on a ride.';
