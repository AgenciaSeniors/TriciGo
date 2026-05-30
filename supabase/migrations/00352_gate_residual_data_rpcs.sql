-- ============================================================
-- Migration 00352: close residual authenticated data-access gaps
--
-- Follow-up to 00348/00349. Revoking anon stopped unauthenticated reads,
-- but these three SECURITY DEFINER functions still let ANY logged-in user
-- read data that isn't theirs:
--   - get_driver_position(driver_id): live GPS of any driver by id
--     (stalking / safety risk). Now restricted to the rider on an ACTIVE
--     ride with that driver, the driver themselves, or an admin.
--   - get_top_drivers / get_commission_by_ride: driver names, revenue and
--     commissions (admin reporting). Now admin-only.
--
-- The two report functions were LANGUAGE sql; converted to plpgsql so a
-- guard can RAISE. `#variable_conflict use_column` keeps the ORDER BY
-- aliases (revenue, rides_count) resolving to result columns, not to the
-- RETURNS TABLE OUT params. Query bodies are otherwise unchanged.
-- ============================================================

-- 1) get_driver_position — ride-scoped.
CREATE OR REPLACE FUNCTION public.get_driver_position(p_driver_id uuid)
 RETURNS TABLE(latitude double precision, longitude double precision, heading double precision, speed double precision, recorded_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only an admin, the driver themselves, or the rider currently on an
  -- active ride with this driver may read the live position.
  IF NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM rides r
       WHERE r.driver_id = p_driver_id
         AND r.customer_id = auth.uid()
         AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
     )
     AND NOT EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = p_driver_id AND dp.user_id = auth.uid()
     )
  THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- 1) Try the most recent ride_location_events row (freshest, has speed)
  RETURN QUERY
  SELECT
    ST_Y(rle.location::geometry)::double precision AS latitude,
    ST_X(rle.location::geometry)::double precision AS longitude,
    COALESCE(rle.heading, 0)::double precision     AS heading,
    COALESCE(rle.speed, 0)::double precision       AS speed,
    rle.recorded_at
  FROM ride_location_events rle
  WHERE rle.driver_id = p_driver_id
    AND rle.recorded_at > now() - interval '60 seconds'
  ORDER BY rle.recorded_at DESC
  LIMIT 1;

  -- 2) If nothing recent, fall back to driver_profiles.current_location
  IF NOT FOUND THEN
    RETURN QUERY
    SELECT
      ST_Y(dp.current_location::geometry)::double precision AS latitude,
      ST_X(dp.current_location::geometry)::double precision AS longitude,
      0::double precision AS heading,
      0::double precision AS speed,
      dp.last_heartbeat_at AS recorded_at
    FROM driver_profiles dp
    WHERE dp.id = p_driver_id
      AND dp.current_location IS NOT NULL
    LIMIT 1;
  END IF;
END;
$function$;

-- 2) get_top_drivers — admin only.
CREATE OR REPLACE FUNCTION public.get_top_drivers(p_limit integer DEFAULT 10)
 RETURNS TABLE(driver_id uuid, driver_name text, rides_count bigint, rating numeric, revenue numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    dp.id AS driver_id,
    u.full_name AS driver_name,
    COALESCE(COUNT(*) FILTER (WHERE r.status = 'completed'), 0) AS rides_count,
    dp.rating_avg AS rating,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0)::numeric AS revenue
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN rides r ON r.driver_id = dp.id
  WHERE dp.status = 'approved'
  GROUP BY dp.id, u.full_name, dp.rating_avg
  ORDER BY revenue DESC, rides_count DESC
  LIMIT p_limit;
END;
$function$;

-- 3) get_commission_by_ride — admin only.
CREATE OR REPLACE FUNCTION public.get_commission_by_ride(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(ride_id uuid, completed_at timestamp with time zone, customer_name text, driver_name text, service_type text, payment_method text, total_fare_cup integer, commission_rate numeric, commission_cup integer, driver_earnings_cup integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    r.id AS ride_id,
    r.completed_at,
    uc.full_name AS customer_name,
    ud.full_name AS driver_name,
    r.service_type::TEXT,
    r.payment_method::TEXT,
    r.final_fare_cup::INTEGER AS total_fare_cup,
    rps.commission_rate,
    ROUND(r.final_fare_cup * rps.commission_rate)::INTEGER AS commission_cup,
    (r.final_fare_cup - ROUND(r.final_fare_cup * rps.commission_rate))::INTEGER AS driver_earnings_cup
  FROM rides r
  JOIN ride_pricing_snapshots rps ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
  LEFT JOIN users uc ON uc.id = r.customer_id
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  LEFT JOIN users ud ON ud.id = dp.user_id
  WHERE r.status = 'completed'
  ORDER BY r.completed_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;
