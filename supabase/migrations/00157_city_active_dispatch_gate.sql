-- ============================================================
-- BUG-091: `cities.is_active` was set by admin via /settings/cities
-- but never enforced anywhere. A driver whose `driver_profiles.city_id`
-- pointed to an inactive city was still offered rides; a ride created
-- with an inactive `rides.city_id` still went through dispatch.
--
-- This migration closes the loop in two places:
--   1. `find_best_drivers` — excludes drivers in inactive cities
--   2. BEFORE INSERT trigger on rides — rejects rides targeting
--      inactive cities with a clear error.
--
-- Driver-profile filter uses LEFT JOIN so drivers without a city_id
-- (e.g. newly onboarded) are not blocked; they only get blocked when
-- an explicit inactive city is set.
-- ============================================================

-- 1) Tweak find_best_drivers to exclude drivers in inactive cities.
CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false
)
 RETURNS TABLE(id uuid, user_id uuid, distance_m double precision, match_score numeric, rating numeric, acceptance_rate numeric, composite double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_type vehicle_type;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  v_vehicle_type := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN 'triciclo'::vehicle_type
    WHEN p_service_type LIKE 'moto%' THEN 'moto'::vehicle_type
    WHEN p_service_type LIKE 'auto%' THEN 'auto'::vehicle_type
    WHEN p_service_type = 'mensajeria' THEN NULL
    ELSE 'triciclo'::vehicle_type
  END;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT dp.id AS dp_id, dp.user_id AS dp_user_id, dp.match_score AS dp_match_score,
      dp.rating_avg AS dp_rating, dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
       FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'
       AND r.created_at > NOW() - INTERVAL '30 days' AND r.accepted_at IS NOT NULL)::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id  -- BUG-091: enforce active cities
    WHERE dp.is_online = true AND dp.status = 'approved' AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_type IS NULL OR v.type = v_vehicle_type)
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND (c.id IS NULL OR c.is_active = true)  -- drivers w/o city not blocked; inactive-city drivers excluded
      AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = dp.user_id
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'))
  )
  SELECT ed.dp_id, ed.dp_user_id, ed.dist_m, ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (0.30 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
     0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
     0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
     0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
     0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
     0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed ORDER BY composite DESC LIMIT p_limit;
END;
$function$;

-- 2) BEFORE INSERT trigger on rides — reject when city_id is set to an inactive city.
CREATE OR REPLACE FUNCTION public.tg_rides_enforce_active_city()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_active BOOLEAN;
BEGIN
  IF NEW.city_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_active INTO v_active FROM cities WHERE id = NEW.city_id;
  IF v_active IS FALSE THEN
    RAISE EXCEPTION 'city_not_active'
      USING HINT = 'The requested ride city is currently disabled by the operator.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rides_enforce_active_city ON public.rides;
CREATE TRIGGER rides_enforce_active_city
BEFORE INSERT OR UPDATE OF city_id ON public.rides
FOR EACH ROW
EXECUTE FUNCTION public.tg_rides_enforce_active_city();

COMMENT ON TRIGGER rides_enforce_active_city ON public.rides IS
  'BUG-091: refuse rides targeting an inactive city. Operator toggles cities.is_active from /settings/cities.';
