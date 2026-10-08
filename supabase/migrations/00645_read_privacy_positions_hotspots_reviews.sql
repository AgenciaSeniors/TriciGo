-- 00645: what one person can read about another — driver positions, demand
-- hotspots, popular destinations and reviews of passengers.
--
-- 1. find_nearby_vehicles (the "cars near you" layer of the rider and driver
--    maps, and of the web booking page) returned, to anyone holding the public
--    key, the exact GPS position (7 decimals), heading and driver_profile_id of
--    every online driver without a ride, with no cap on radius or count.
--    Measured in prod on 2026-10-08 as anon: from latitude 0, longitude 0 with
--    a 20,000 km radius it returned the one driver online, to the centimetre.
--    Polled over a day, that is where each driver is and, at the start and end
--    of a shift, where each driver lives. Now:
--    - only signed-in users (every caller is behind login: client, driver and
--      web /book and /track);
--    - radius at most 5 km and at most 50 vehicles (what the apps ask for);
--    - each position is shown inside its real cell of 0.002 degrees (about
--      220 x 205 m in Cuba) at a point that depends on the driver and the hour,
--      never on where in the cell the driver is. The radius filter and the
--      order use that shown point too: deciding membership on the real position
--      would let a caller shrink the radius around a guess and find it;
--    - the id is opaque and changes every hour (markers keep their identity
--      while the map is open); the caller's own vehicle is left out on the
--      server, which is what the driver app did with the old id.
--    The secret that makes the shown point unpredictable lives in a locked
--    table (nearby_vehicle_salt), read only by this function.
--
-- 2. get_demand_hotspots (drivers' demand layer) placed historical hotspots at
--    the exact average of the pickups of a cell, and the materialized view it
--    reads (hourly_demand_cells) was readable by anyone: three rides from the
--    same doorway at the same weekday and hour put a hotspot on that doorway.
--    Live hotspots likewise averaged exact pickup points. Hotspots now sit on
--    the cell's grid point (0.005 degrees, about 550 m), live pickups are
--    snapped to that grid before clustering, both radius filters use the
--    snapped points, and the view is no longer readable by clients (the
--    function is SECURITY DEFINER and reads it as its owner). The view has no
--    rows today; this closes it before it has any.
--
-- 3. get_destination_suggestions offered, to any signed-in user near a place,
--    the "popular" dropoff addresses: cells with 3 or more completed rides in
--    90 days, counting rides, not people. One rider going home three times
--    made their home address (with house number) a suggestion for everyone
--    within 15 km. Now a cell needs 3 different riders. No cell qualifies in
--    prod today, either way. Patched in place on the live body (md5 checked).
--
-- 4. reviews: every visible review was readable by anyone, anon included: the
--    rating and comment a driver left about a passenger, who rode with whom
--    and when (reviewer_id, reviewee_id, ride_id). Prod has 7: 5 of drivers,
--    2 of passengers. The public driver profile needs the reviews OF DRIVERS,
--    and only signed-in users open it. Now:
--    - a review of the ride's driver, visible, is readable by signed-in users;
--    - a review of a passenger, by that passenger, its author and admins;
--    - the author always reads their own review (hidden ones too, which also
--      keeps the app from offering to rate the same ride twice);
--    - review_tags follow their review.
--    get_review_summary/get_review_tag_summary are SECURITY INVOKER and read
--    through the same policy: a driver's public summary keeps counting the
--    reviews of that driver.
--
-- Rehearsal: supabase/tests/00645/run.sh (local Postgres 16 + PostGIS, live bodies).

SET lock_timeout = '10s';

-- 0. Refuse to replace bodies this migration does not know ---------------------
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
  WHERE oid = 'public.find_nearby_vehicles(double precision,double precision,text,integer,integer)'::regprocedure;
  IF v_md5 NOT IN ('d8f7ccb01d9dd78a6022c905563c3092', '84b198263456992160212f951b8419d3') THEN
    RAISE EXCEPTION '00645: unexpected body of find_nearby_vehicles (md5 %): not replaced', v_md5;
  END IF;
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc
  WHERE oid = 'public.get_demand_hotspots(double precision,double precision,integer)'::regprocedure;
  IF v_md5 NOT IN ('a287c466520a5a9de1f2d94a1e2470fd', '40e675a5881746c391aec3154305f9c3') THEN
    RAISE EXCEPTION '00645: unexpected body of get_demand_hotspots (md5 %): not replaced', v_md5;
  END IF;
END
$guard$;

-- 1. Driver positions -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.nearby_vehicle_salt (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt text NOT NULL
);
ALTER TABLE public.nearby_vehicle_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nearby_vehicle_salt FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nearby_vehicle_salt TO service_role;
INSERT INTO public.nearby_vehicle_salt (id, salt)
VALUES (1, md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text))
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.find_nearby_vehicles(p_lat double precision, p_lng double precision, p_vehicle_type text DEFAULT NULL::text, p_radius_m integer DEFAULT 5000, p_limit integer DEFAULT 50)
 RETURNS TABLE(driver_profile_id uuid, latitude double precision, longitude double precision, heading double precision, vehicle_type text, custom_per_km_rate_cup integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- 00645: positions are shown inside the driver's real cell of c_cell degrees,
  -- at a point that depends on the driver and the hour, not on where in the
  -- cell the driver is. The id is opaque and changes every hour.
  c_cell   CONSTANT double precision := 0.002;
  c_max_r  CONSTANT integer := 5000;
  c_max_n  CONSTANT integer := 50;
  v_uid    uuid := auth.uid();
  v_center geography;
  v_radius integer := LEAST(GREATEST(COALESCE(p_radius_m, c_max_r), 1), c_max_r);
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, c_max_n), 1), c_max_n);
  v_key    text;
BEGIN
  IF v_uid IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN;
  END IF;
  v_center := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  SELECT s.salt INTO v_key FROM nearby_vehicle_salt s WHERE s.id = 1;
  v_key := COALESCE(v_key, '') || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDDHH24');

  RETURN QUERY
  WITH cand AS (
    SELECT
      ST_Y(dp.current_location::geometry) AS real_lat,
      ST_X(dp.current_location::geometry) AS real_lng,
      dp.current_heading::double precision AS hdg,
      v.type::text AS vtype,
      dp.custom_per_km_rate_cup AS rate,
      md5(v_key || dp.id::text) AS h
    FROM driver_profiles dp
    INNER JOIN vehicles v
      ON v.driver_id = dp.id
      AND v.is_active = true
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.current_location IS NOT NULL
      AND dp.user_id IS DISTINCT FROM v_uid
      -- Index pre-filter on the real position, with a margin wider than a
      -- cell's diagonal (about 300 m): the filter that decides is below, on
      -- the shown position.
      AND ST_DWithin(dp.current_location, v_center, v_radius + 400)
      AND (p_vehicle_type IS NULL OR v.type::text = p_vehicle_type)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
      )
  ),
  shown AS (
    SELECT
      md5('id' || c.h)::uuid AS sid,
      floor(c.real_lat / c_cell) * c_cell
        + c_cell * (('x' || substr(c.h, 1, 8))::bit(32)::bigint / 4294967296.0::double precision) AS s_lat,
      floor(c.real_lng / c_cell) * c_cell
        + c_cell * (('x' || substr(c.h, 9, 8))::bit(32)::bigint / 4294967296.0::double precision) AS s_lng,
      c.hdg, c.vtype, c.rate
    FROM cand c
  ),
  placed AS (
    SELECT s.*, ST_SetSRID(ST_MakePoint(s.s_lng, s.s_lat), 4326)::geography AS g
    FROM shown s
  )
  SELECT p.sid, p.s_lat, p.s_lng, p.hdg, p.vtype, p.rate
  FROM placed p
  WHERE ST_DWithin(p.g, v_center, v_radius)
  ORDER BY ST_Distance(p.g, v_center), p.sid
  LIMIT v_limit;
END;
$function$;
REVOKE ALL ON FUNCTION public.find_nearby_vehicles(double precision, double precision, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_nearby_vehicles(double precision, double precision, text, integer, integer) TO authenticated, service_role;

-- 2. Demand hotspots ---------------------------------------------------------------
REVOKE ALL ON public.hourly_demand_cells FROM anon, authenticated;
GRANT SELECT ON public.hourly_demand_cells TO service_role;

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
    -- 00645: the cell's grid point, not the average of its pickups.
    SELECT
      hdc.cell_geom AS center_geom,
      hdc.ride_count AS hist_count
    FROM hourly_demand_cells hdc, center c
    WHERE hdc.dow = c.dow AND hdc.hour = c.hour
      AND ST_DWithin(hdc.cell_geom::geography, c.geog, p_radius_m)
  ),
  live_raw AS (
    -- 00645: pickups snapped to the same 0.005-degree grid before anything else.
    SELECT ST_SnapToGrid(r.pickup_location::geometry, 0.005) AS g
    FROM rides r, center c
    WHERE r.status = 'searching'
      AND r.created_at > now() - interval '10 minutes'
      AND ST_DWithin(r.pickup_location, c.geog, p_radius_m + 600)
      AND ST_DWithin(ST_SnapToGrid(r.pickup_location::geometry, 0.005)::geography, c.geog, p_radius_m)
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
$function$;

-- 3. Popular destinations need 3 different riders ---------------------------------
DO $patch$
DECLARE
  c_fn      CONSTANT regprocedure := 'public.get_destination_suggestions(uuid,double precision,double precision,integer,integer)'::regprocedure;
  c_old_md5 CONSTANT text := 'f30abb2bacd8ed35865e9e2435bbbea2';
  c_new_md5 CONSTANT text := 'd4841a72cef0980810b10f4a3df37664';
  c_old     CONSTANT text := 'HAVING count(*) >= 3';
  c_new     CONSTANT text := 'HAVING count(DISTINCT r.customer_id) >= 3';
  v_md5 text;
  v_def text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_new_md5 THEN
    RETURN;
  ELSIF v_md5 IS DISTINCT FROM c_old_md5 THEN
    RAISE EXCEPTION '00645: unexpected body of get_destination_suggestions (md5 %): not patched', v_md5;
  END IF;
  v_def := pg_get_functiondef(c_fn);
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION '00645: get_destination_suggestions does not carry % exactly once', c_old;
  END IF;
  EXECUTE replace(v_def, c_old, c_new);
END
$patch$;

-- 4. Reviews of passengers are private --------------------------------------------
CREATE OR REPLACE FUNCTION public.review_is_public(p_review_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  -- 00645: a visible review of the ride's driver, read by a signed-in user.
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM reviews rv
    JOIN rides r ON r.id = rv.ride_id
    JOIN driver_profiles dp ON dp.id = r.driver_id
    WHERE rv.id = p_review_id
      AND rv.is_visible = true
      AND dp.user_id = rv.reviewee_id
  );
$function$;
-- The policy below runs as the reader, anon included: anon needs EXECUTE or
-- every read of reviews would fail with 42501 (the 00592 lesson). It answers
-- false without a signed-in user.
REVOKE ALL ON FUNCTION public.review_is_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_is_public(uuid) TO anon, authenticated, service_role;

ALTER POLICY rev_select ON public.reviews
  USING ((reviewer_id = ( SELECT auth.uid() AS uid))
      OR (reviewee_id = ( SELECT auth.uid() AS uid))
      OR public.is_admin()
      OR public.review_is_public(id));
ALTER POLICY rt_select ON public.review_tags
  USING (EXISTS ( SELECT 1 FROM public.reviews r WHERE r.id = review_tags.review_id));

-- 5. Pasted from Windows (CRLF), the new bodies would carry \r: recreate them from
--    the catalog without them so their md5 matches git.
DO $fix$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.find_nearby_vehicles(double precision,double precision,text,integer,integer)',
    'public.get_demand_hotspots(double precision,double precision,integer)',
    'public.review_is_public(uuid)'
  ]::regprocedure[] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$fix$;

-- 6. Check the result -------------------------------------------------------------
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.find_nearby_vehicles(double precision,double precision,text,integer,integer)'::regprocedure) <> '84b198263456992160212f951b8419d3' THEN
    RAISE EXCEPTION '00645: find_nearby_vehicles is not the body of git';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_demand_hotspots(double precision,double precision,integer)'::regprocedure) <> '40e675a5881746c391aec3154305f9c3' THEN
    RAISE EXCEPTION '00645: get_demand_hotspots is not the body of git';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_destination_suggestions(uuid,double precision,double precision,integer,integer)'::regprocedure) <> 'd4841a72cef0980810b10f4a3df37664' THEN
    RAISE EXCEPTION '00645: get_destination_suggestions is not the patched body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.review_is_public(uuid)'::regprocedure) <> 'ed85404a46aaaefe2eba62001847d57d' THEN
    RAISE EXCEPTION '00645: review_is_public is not the body of git';
  END IF;
  IF has_function_privilege('anon', 'public.find_nearby_vehicles(double precision,double precision,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '00645: anon can still call find_nearby_vehicles';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.find_nearby_vehicles(double precision,double precision,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '00645: signed-in users lost find_nearby_vehicles';
  END IF;
  IF has_table_privilege('anon', 'public.hourly_demand_cells', 'SELECT')
     OR has_table_privilege('authenticated', 'public.hourly_demand_cells', 'SELECT') THEN
    RAISE EXCEPTION '00645: clients can still read hourly_demand_cells';
  END IF;
  IF has_table_privilege('anon', 'public.nearby_vehicle_salt', 'SELECT')
     OR has_table_privilege('authenticated', 'public.nearby_vehicle_salt', 'SELECT') THEN
    RAISE EXCEPTION '00645: clients can read nearby_vehicle_salt';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.nearby_vehicle_salt WHERE id = 1 AND length(salt) = 64) THEN
    RAISE EXCEPTION '00645: nearby_vehicle_salt has no salt';
  END IF;
  IF NOT has_function_privilege('anon', 'public.review_is_public(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00645: anon cannot evaluate rev_select (review_is_public)';
  END IF;
END
$check$;

RESET lock_timeout;
