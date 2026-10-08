-- 00644: vehicle plates are no longer readable by every signed-in user.
--
-- The policy v_select let any signed-in user (anyone, after a phone OTP) list
-- every active vehicle: plate, make, model, colour, year, photo and the
-- driver's profile id. Prod had 164 active vehicles, all with a plate. A
-- scraper could build the whole fleet with one request.
--
-- Who still reads a vehicle:
-- - its driver (own branch, unchanged; the driver app reads and edits its own);
-- - a rider, the vehicles of drivers they have a ride with (any status): the
--   active-ride screen and the ride history read the assigned driver's vehicle
--   by driver_id. The subquery on rides runs under the rider's own RLS;
-- - admins (unchanged).
--
-- The rider app also read every active cargo vehicle to build the delivery
-- vehicle selector. That now comes from get_cargo_vehicle_caps(), which
-- aggregates per vehicle type on the server (largest of each dimension, union
-- of categories, count) and returns no plate, photo or driver id. App builds
-- older than this change still read the table directly: they see no cargo
-- vehicle and grey out the four types until they update. Decided by the owner
-- on 2026-10-08: 3 deliveries ever, the last on 2026-08-02, and the web does
-- not use that read.
--
-- Rehearsal: supabase/tests/00644/run.sh (local Postgres 16, prod's policies).

SET lock_timeout = '10s';

-- 0. Refuse to replace a v_select this migration does not know ---------------------
DO $guard$
DECLARE
  v_qual text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_qual FROM pg_policy
  WHERE polrelid = 'public.vehicles'::regclass AND polname = 'v_select';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION '00644: policy v_select on vehicles is missing';
  END IF;
  -- Before: own OR (signed in AND is_active) OR admin. After: own OR rider of a
  -- ride with that driver OR admin.
  IF NOT (position('(is_active = true)' IN v_qual) > 0 OR position('rides r' IN v_qual) > 0) THEN
    RAISE EXCEPTION '00644: v_select is not the policy this migration replaces: %', v_qual;
  END IF;
END
$guard$;

-- 1. Delivery selector without plates ----------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cargo_vehicle_caps()
 RETURNS TABLE(vehicle_type text, max_weight_kg numeric, max_length_cm integer, max_width_cm integer, max_height_cm integer, accepted_categories text[], available_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  -- 00644: what the delivery selector needs, per vehicle type, from every
  -- active cargo vehicle. No plate, photo or driver id.
  SELECT
    v.type::text,
    max(v.max_cargo_weight_kg),
    max(v.max_cargo_length_cm),
    max(v.max_cargo_width_cm),
    max(v.max_cargo_height_cm),
    COALESCE((
      SELECT array_agg(DISTINCT c ORDER BY c)
      FROM vehicles v2, unnest(v2.accepted_cargo_categories) c
      WHERE v2.type = v.type AND v2.is_active AND v2.accepts_cargo
    ), '{}'::text[]),
    count(*)::integer
  FROM vehicles v
  WHERE v.is_active AND v.accepts_cargo
  GROUP BY v.type
  ORDER BY v.type;
$function$;
REVOKE ALL ON FUNCTION public.get_cargo_vehicle_caps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cargo_vehicle_caps() TO authenticated, service_role;

-- 2. Riders read only the vehicles of drivers they rode with -------------------------
ALTER POLICY v_select ON public.vehicles
  USING ((driver_id IN ( SELECT driver_profiles.id
     FROM public.driver_profiles
    WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid))))
      OR (driver_id IN ( SELECT r.driver_id
     FROM public.rides r
    WHERE (r.customer_id = ( SELECT auth.uid() AS uid))))
      OR public.is_admin());

-- 3. Pasted from Windows (CRLF), the new body would carry \r: recreate it from the
--    catalog without them so its md5 matches git.
DO $fix$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.get_cargo_vehicle_caps()'::regprocedure);
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$fix$;

-- 4. Check the result ---------------------------------------------------------------
DO $check$
DECLARE
  v_qual text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_cargo_vehicle_caps()'::regprocedure) <> 'e4d063916fcd783dbec9371253d9fbfb' THEN
    RAISE EXCEPTION '00644: get_cargo_vehicle_caps is not the body of git';
  END IF;
  IF has_function_privilege('anon', 'public.get_cargo_vehicle_caps()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_cargo_vehicle_caps()', 'EXECUTE') THEN
    RAISE EXCEPTION '00644: get_cargo_vehicle_caps must be callable by signed-in users only';
  END IF;
  SELECT pg_get_expr(polqual, polrelid) INTO v_qual FROM pg_policy
  WHERE polrelid = 'public.vehicles'::regclass AND polname = 'v_select';
  IF position('is_active' IN v_qual) > 0 OR position('rides r' IN v_qual) = 0 THEN
    RAISE EXCEPTION '00644: v_select still lets every signed-in user read active vehicles: %', v_qual;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.vehicles'::regclass AND polcmd IN ('r', '*')
             AND polname NOT IN ('v_select', 'v_admin_select')) THEN
    RAISE EXCEPTION '00644: another SELECT policy on vehicles would keep plates readable';
  END IF;
END
$check$;

RESET lock_timeout;
