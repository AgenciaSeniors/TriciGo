-- Scaffold for the 00645 rehearsal: the tables and columns the four functions
-- read, with the LIVE bodies read from prod on 2026-10-08 (md5/length checked
-- by S0): find_nearby_vehicles, get_demand_hotspots, get_destination_suggestions
-- and can_review_ride, plus auth.uid(), current_user_role() and is_admin()
-- (00592). reviews and review_tags carry prod's columns, policies and grants;
-- hourly_demand_cells is prod's materialized view with its grants and indexes.
-- Policies on users/driver_profiles/rides/vehicles are simplified to own-row
-- (the functions under test are SECURITY DEFINER and do not go through them).
-- PostGIS lives in public, as in prod. A NON-superuser role (prod: postgres)
-- owns everything; run.sh applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid,
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean NOT NULL DEFAULT false,
  current_location geography,
  current_heading numeric,
  custom_per_km_rate_cup integer
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)) OR is_admin());
GRANT ALL ON public.driver_profiles TO anon, authenticated, service_role;

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  type public.vehicle_type NOT NULL,
  plate_number text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.vehicles TO anon, authenticated, service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  driver_id uuid,
  status public.ride_status NOT NULL DEFAULT 'searching',
  pickup_location geography,
  dropoff_location geography,
  dropoff_address text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  dropoff_lat double precision,
  dropoff_lng double precision
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING ((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin());
GRANT ALL ON public.rides TO anon, authenticated, service_role;

-- reviews / review_tags: prod's columns, policies and grants (2026-10-08).
CREATE TABLE public.reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  reviewer_id uuid,
  reviewee_id uuid,
  rating smallint,
  comment text,
  is_visible boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  is_featured boolean DEFAULT false
);
CREATE TABLE public.review_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id uuid,
  tag_id uuid,
  created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_tags ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.reviews, public.review_tags TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_review_ride(p_ride_id uuid, p_reviewer_id uuid, p_reviewee_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.rides r
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    WHERE r.id = p_ride_id
      AND r.status = 'completed'::ride_status
      AND (
        (r.customer_id = p_reviewer_id AND dp.user_id = p_reviewee_id)
        OR
        (dp.user_id = p_reviewer_id AND r.customer_id = p_reviewee_id)
      )
  );
$function$
;
REVOKE ALL ON FUNCTION public.can_review_ride(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_review_ride(uuid, uuid, uuid) TO authenticated, service_role;

CREATE POLICY rev_admin ON public.reviews FOR ALL USING (is_admin());
CREATE POLICY rev_admin_select ON public.reviews FOR SELECT USING (is_admin());
CREATE POLICY rev_insert ON public.reviews FOR INSERT TO authenticated
  WITH CHECK (((reviewer_id = ( SELECT auth.uid() AS uid)) AND (reviewer_id <> reviewee_id) AND can_review_ride(ride_id, reviewer_id, reviewee_id)));
CREATE POLICY rev_select ON public.reviews FOR SELECT
  USING (((is_visible = true) OR (reviewee_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY rt_insert ON public.review_tags FOR INSERT
  WITH CHECK ((EXISTS ( SELECT 1
   FROM reviews
  WHERE ((reviews.id = review_tags.review_id) AND (reviews.reviewer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY rt_select ON public.review_tags FOR SELECT USING (true);

-- Review summaries (SECURITY INVOKER in prod): they read through the policies above.
CREATE OR REPLACE FUNCTION public.get_review_summary(p_user_id uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT json_build_object(
    'user_id', p_user_id,
    'average_rating', COALESCE(ROUND(AVG(rating)::numeric, 2), 5.00),
    'total_reviews', COUNT(*)::int,
    'rating_distribution', json_build_object(
      '1', COUNT(*) FILTER (WHERE rating = 1),
      '2', COUNT(*) FILTER (WHERE rating = 2),
      '3', COUNT(*) FILTER (WHERE rating = 3),
      '4', COUNT(*) FILTER (WHERE rating = 4),
      '5', COUNT(*) FILTER (WHERE rating = 5)
    )
  )
  FROM reviews
  WHERE reviewee_id = p_user_id AND is_visible = true;
$function$
;
GRANT EXECUTE ON FUNCTION public.get_review_summary(uuid) TO anon, authenticated, service_role;

-- hourly_demand_cells: prod's definition, indexes and grants.
CREATE MATERIALIZED VIEW public.hourly_demand_cells AS
 SELECT st_snaptogrid((pickup_location)::geometry, (0.005)::double precision) AS cell_geom,
    (EXTRACT(dow FROM created_at))::integer AS dow,
    (EXTRACT(hour FROM created_at))::integer AS hour,
    count(*) AS ride_count,
    st_centroid(st_collect((pickup_location)::geometry)) AS center_geom
   FROM rides
  WHERE ((created_at > (now() - '28 days'::interval)) AND (status IS DISTINCT FROM 'canceled'::ride_status))
  GROUP BY (st_snaptogrid((pickup_location)::geometry, (0.005)::double precision)), ((EXTRACT(dow FROM created_at))::integer), ((EXTRACT(hour FROM created_at))::integer)
 HAVING (count(*) >= 3);
CREATE UNIQUE INDEX hourly_demand_cells_uniq_idx ON public.hourly_demand_cells USING btree (cell_geom, dow, hour);
CREATE INDEX hourly_demand_cells_gist_idx ON public.hourly_demand_cells USING gist (cell_geom);
CREATE INDEX hourly_demand_cells_dow_hour_idx ON public.hourly_demand_cells USING btree (dow, hour);
GRANT ALL ON public.hourly_demand_cells TO anon, authenticated, service_role;

-- LIVE bodies (prod, 2026-10-08) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_nearby_vehicles(p_lat double precision, p_lng double precision, p_vehicle_type text DEFAULT NULL::text, p_radius_m integer DEFAULT 5000, p_limit integer DEFAULT 50)
 RETURNS TABLE(driver_profile_id uuid, latitude double precision, longitude double precision, heading double precision, vehicle_type text, custom_per_km_rate_cup integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_center GEOGRAPHY;
BEGIN
  v_center := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  RETURN QUERY
  SELECT
    dp.id AS driver_profile_id,
    ST_Y(dp.current_location::geometry) AS latitude,
    ST_X(dp.current_location::geometry) AS longitude,
    dp.current_heading::DOUBLE PRECISION AS heading,
    v.type::TEXT AS vehicle_type,
    dp.custom_per_km_rate_cup
  FROM driver_profiles dp
  INNER JOIN vehicles v
    ON v.driver_id = dp.id
    AND v.is_active = true
  WHERE dp.is_online = true
    AND dp.status = 'approved'
    AND dp.current_location IS NOT NULL
    AND ST_DWithin(dp.current_location, v_center, p_radius_m)
    AND (p_vehicle_type IS NULL OR v.type::TEXT = p_vehicle_type)
    AND NOT EXISTS (
      SELECT 1 FROM rides r
      WHERE r.driver_id = dp.id
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
    )
  ORDER BY ST_Distance(dp.current_location, v_center)
  LIMIT p_limit;
END;
$function$
;
GRANT EXECUTE ON FUNCTION public.find_nearby_vehicles(double precision, double precision, text, integer, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_demand_hotspots(p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 5000)
 RETURNS TABLE(id text, lat double precision, lng double precision, intensity double precision, live_rides_count integer, historical_rides_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
WITH
  center AS (
    SELECT
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS geog,
      EXTRACT(DOW FROM now())::int  AS dow,
      EXTRACT(HOUR FROM now())::int AS hour
  ),
  hist AS (
    SELECT
      hdc.center_geom,
      hdc.ride_count AS hist_count
    FROM hourly_demand_cells hdc, center c
    WHERE hdc.dow = c.dow AND hdc.hour = c.hour
      AND ST_DWithin(hdc.center_geom::geography, c.geog, p_radius_m)
  ),
  live_raw AS (
    SELECT r.pickup_location::geometry AS g
    FROM rides r, center c
    WHERE r.status = 'searching'
      AND r.created_at > now() - interval '10 minutes'
      AND ST_DWithin(r.pickup_location, c.geog, p_radius_m)
  ),
  live_clustered AS (
    SELECT g, ST_ClusterDBSCAN(g, eps := 0.005, minpoints := 2) OVER () AS cid
    FROM live_raw
  ),
  live_agg AS (
    SELECT
      ST_Centroid(ST_Collect(g))::geometry AS center_geom,
      count(*)::int                        AS live_count
    FROM live_clustered
    WHERE cid IS NOT NULL
    GROUP BY cid
  ),
  unioned AS (
    SELECT center_geom, hist_count, 0::int AS live_count FROM hist
    UNION ALL
    SELECT center_geom, 0::int AS hist_count, live_count FROM live_agg
  ),
  merged_raw AS (
    SELECT
      center_geom,
      hist_count,
      live_count,
      ST_ClusterDBSCAN(center_geom, eps := 0.006, minpoints := 1) OVER () AS mid
    FROM unioned
  ),
  merged AS (
    SELECT
      gen_random_uuid()::text AS id,
      ST_Y(ST_Centroid(ST_Collect(center_geom)))::double precision AS lat,
      ST_X(ST_Centroid(ST_Collect(center_geom)))::double precision AS lng,
      sum(hist_count)::int AS hist_count,
      sum(live_count)::int AS live_count
    FROM merged_raw
    WHERE mid IS NOT NULL
    GROUP BY mid
  ),
  maxes AS (
    SELECT
      GREATEST(max(hist_count), 1) AS max_hist,
      GREATEST(max(live_count), 1) AS max_live
    FROM merged
  )
SELECT
  m.id,
  m.lat,
  m.lng,
  LEAST(
    1.0,
    0.5 * (m.hist_count::double precision / mx.max_hist)
    + 0.5 * (m.live_count::double precision / mx.max_live)
  ) AS intensity,
  m.live_count        AS live_rides_count,
  m.hist_count        AS historical_rides_count
FROM merged m, maxes mx
WHERE m.hist_count + m.live_count > 0
ORDER BY intensity DESC
LIMIT 8;
$function$
;
REVOKE ALL ON FUNCTION public.get_demand_hotspots(double precision, double precision, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_demand_hotspots(double precision, double precision, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_destination_suggestions(p_user_id uuid, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_hour integer DEFAULT NULL::integer, p_limit integer DEFAULT 5)
 RETURNS TABLE(address text, latitude double precision, longitude double precision, score double precision, reason text, source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_hour  int := COALESCE(p_hour, EXTRACT(hour FROM now() AT TIME ZONE 'America/Havana')::int);
  v_dow   int := EXTRACT(dow  FROM now() AT TIME ZONE 'America/Havana')::int;
  v_limit int := GREATEST(LEAST(COALESCE(p_limit, 5), 10), 1);
BEGIN
  IF p_user_id IS NULL OR NOT (COALESCE(auth.uid() = p_user_id, false) OR public.is_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH personal_cells AS (
    SELECT
      count(*)                                                    AS frequency,
      count(*) FILTER (
        WHERE EXTRACT(hour FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_hour
      )                                                           AS hour_count,
      count(*) FILTER (
        WHERE EXTRACT(dow FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_dow
      )                                                           AS day_count,
      max(r.created_at)                                           AS last_visited,
      avg(r.dropoff_lat)                                          AS lat,
      avg(r.dropoff_lng)                                          AS lng,
      (array_agg(r.dropoff_address ORDER BY
        (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
        r.created_at DESC))[1]                                    AS addr
    FROM public.rides r
    WHERE r.customer_id = p_user_id
      AND r.status = 'completed'
      AND r.dropoff_lat IS NOT NULL
      AND r.dropoff_lng IS NOT NULL
      AND r.dropoff_address IS NOT NULL
    GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
  ),
  personal_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END)::double precision AS score,
      CASE WHEN pc.day_count >= 2 AND pc.hour_count >= 2 THEN 'time_pattern'
           WHEN pc.hour_count >= 2                       THEN 'time_pattern'
           WHEN pc.frequency  >= 3                       THEN 'frequent'
           ELSE 'recent' END AS reason,
      'personal'::text AS source
    FROM personal_cells pc
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END) >= 3
    ORDER BY score DESC
    LIMIT v_limit
  ),
  popular_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      pc.frequency::double precision AS score,
      'popular'::text AS reason,
      'popular'::text AS source
    FROM (
      SELECT
        (array_agg(r.dropoff_address ORDER BY
          (r.dropoff_address ~ '\d' OR r.dropoff_address LIKE '% e/ %') DESC,
          r.created_at DESC))[1] AS addr,
        avg(r.dropoff_lat) AS lat,
        avg(r.dropoff_lng) AS lng,
        count(*)           AS frequency
      FROM public.rides r
      WHERE r.status = 'completed'
        AND r.created_at >= now() - interval '90 days'
        AND r.dropoff_lat IS NOT NULL
        AND r.dropoff_lng IS NOT NULL
        AND r.dropoff_address IS NOT NULL
        AND (
          p_lat IS NULL OR p_lng IS NULL
          OR ST_DWithin(
               r.dropoff_location,
               ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
               15000
             )
        )
      GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
      HAVING count(*) >= 3
    ) pc
    WHERE (pc.addr ~ '\d' OR pc.addr LIKE '% e/ %'
           OR (length(pc.addr) - length(replace(pc.addr, ',', ''))) >= 2)
      AND NOT EXISTS (
        SELECT 1 FROM personal_top pt
        WHERE abs(pt.lat - pc.lat) < 0.0015
          AND abs(pt.lng - pc.lng) < 0.0015
      )
    ORDER BY pc.frequency DESC
    LIMIT v_limit
  )
  SELECT s.address, s.lat AS latitude, s.lng AS longitude, s.score, s.reason, s.source
  FROM (
    SELECT pt.address, pt.lat, pt.lng, pt.score, pt.reason, pt.source, 0 AS tier FROM personal_top pt
    UNION ALL
    SELECT pp.address, pp.lat, pp.lng, pp.score, pp.reason, pp.source, 1 AS tier FROM popular_top pp
  ) s
  ORDER BY s.tier, s.score DESC
  LIMIT v_limit;
END;
$function$
;
GRANT EXECUTE ON FUNCTION public.get_destination_suggestions(uuid, double precision, double precision, integer, integer) TO authenticated, service_role;

RESET ROLE;
