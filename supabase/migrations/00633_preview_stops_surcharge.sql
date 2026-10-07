-- ============================================================
-- 00633 — preview_stops_surcharge: the stops' surcharge before the ride exists
--
-- WHY (reproduced in prod on 2026-10-07 inside a rolled-back block)
--   A ride booked with stops paid the detour twice. The app and the web
--   priced it over the full route through the stops, created the ride with
--   that fare, and then inserted the stops; trg_recalc_fare_on_waypoint_change
--   (00386, written for a stop added mid-trip) added the detour surcharge on
--   top. Capitolio -> Hotel Nacional via the Plaza, quoted at 9,000, ended at
--   10,516 in the snapshot complete_ride_and_pay charges. No ride was ever
--   booked with stops in prod (the only one added its stop later), so nobody
--   paid it yet.
--
-- WHAT
--   The apps now price a booking with stops as the direct fare plus the
--   detour surcharge, and create the ride with the direct fare: the server
--   adds the surcharge itself when the stops are inserted, as it does for a
--   stop added mid-trip. The price shown is the price charged, and the
--   server stays the only one that prices stops.
--   preview_stops_surcharge() returns that surcharge before the ride exists,
--   with the exact formula of _waypoint_pricing() (00386): the straight path
--   pickup -> stops -> dropoff minus the straight pickup -> dropoff, x 1.3,
--   x the service's per_km_rate_cup in service_type_configs, x the surge,
--   rounded. The surge is clamped to [1, 3] like a client's insert (00631).
--   _waypoint_pricing() is not touched; the rehearsal checks that both give
--   the same number on random rides.
--   SECURITY INVOKER (it reads only service_type_configs, readable by every
--   client) and executable by anon too: the web quotes before sign-in.
--   More than 10 stops is refused (the apps allow 3).
--
-- Rehearsal: supabase/tests/00633/run.sh
-- ============================================================

CREATE OR REPLACE FUNCTION public.preview_stops_surcharge(
  p_service_type text,
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_stops jsonb,
  p_surge numeric DEFAULT 1
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_n        integer;
  v_pickup   geometry;
  v_dropoff  geometry;
  v_direct_m numeric;
  v_path_m   numeric;
  v_extra    numeric;
  v_per_km   numeric;
  v_surge    numeric;
BEGIN
  IF p_stops IS NULL OR jsonb_typeof(p_stops) <> 'array' THEN
    RETURN 0;
  END IF;
  v_n := jsonb_array_length(p_stops);
  IF v_n = 0 THEN
    RETURN 0;
  END IF;
  IF v_n > 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'too many stops', DETAIL = 'stops_limit';
  END IF;
  IF p_pickup_lat IS NULL OR p_pickup_lng IS NULL OR p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL THEN
    RETURN 0;
  END IF;

  -- Same points _waypoint_pricing reads back from rides and ride_waypoints.
  v_pickup  := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326);
  v_dropoff := ST_SetSRID(ST_MakePoint(p_dropoff_lng, p_dropoff_lat), 4326);

  v_direct_m := ST_Length(ST_MakeLine(v_pickup, v_dropoff)::geography);

  WITH pts AS (
    SELECT v_pickup AS geom, 0 AS ord
    UNION ALL
    SELECT ST_SetSRID(ST_MakePoint((s.value ->> 'lng')::double precision,
                                   (s.value ->> 'lat')::double precision), 4326),
           s.ordinality::int
      FROM jsonb_array_elements(p_stops) WITH ORDINALITY AS s(value, ordinality)
    UNION ALL
    SELECT v_dropoff, 9999
  )
  SELECT ST_Length(ST_MakeLine(geom ORDER BY ord)::geography) INTO v_path_m FROM pts;

  IF v_path_m IS NULL THEN
    RETURN 0;
  END IF;

  v_extra := GREATEST(v_path_m - v_direct_m, 0) * 1.3;

  SELECT per_km_rate_cup INTO v_per_km
  FROM service_type_configs
  WHERE slug = p_service_type AND is_active = true
  LIMIT 1;
  IF v_per_km IS NULL THEN
    RETURN 0;
  END IF;

  v_surge := LEAST(GREATEST(COALESCE(NULLIF(p_surge, 0), 1), 1), 3);

  RETURN ROUND(v_extra / 1000.0 * v_per_km * v_surge)::int;
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric) TO anon, authenticated, service_role;

-- Pasted into the SQL Editor from Windows, the body above carries \r\n line
-- ends: it works, but no longer matches git. Recreate it without the \r.
DO $crlf$
DECLARE
  v_def text := pg_get_functiondef('public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)'::regprocedure);
BEGIN
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)'::regprocedure)
     IS DISTINCT FROM 'a5ee2672e5ec5425dba514fc61dc16fc' THEN
    RAISE EXCEPTION '00633: preview_stops_surcharge is not the 00633 body';
  END IF;
  IF (SELECT prosecdef FROM pg_proc
      WHERE oid = 'public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)'::regprocedure) THEN
    RAISE EXCEPTION '00633: preview_stops_surcharge must be SECURITY INVOKER';
  END IF;
  IF NOT has_function_privilege('anon', 'public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION '00633: the apps cannot call preview_stops_surcharge';
  END IF;
END
$check$;
