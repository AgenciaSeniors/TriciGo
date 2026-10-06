-- Scaffold for the 00610 rehearsal. The migration only changes who may EXECUTE seven
-- functions, so this models what that depends on, read from prod on 2026-10-06
-- (00609 applied):
--   * the exact signatures and owners of the seven functions, and their proacl
--     (PUBLIC keeps its default EXECUTE on _waypoint_pricing only);
--   * a SECURITY DEFINER caller for each, like dispatch_ride, accept_ride_v2 and the
--     notify triggers in prod (all SECURITY DEFINER, owned by postgres);
--   * two functions the migration must NOT touch, with their prod proacl.
-- get_driver_user_id carries its live body (the migration's probe calls it); the
-- other bodies are stubs that return a constant, because no check depends on them.
-- As in prod, a NON-superuser role (prod: postgres) owns everything and run.sh applies
-- the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
);
INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002');

-- LIVE body (md5 a11e7a77d9dcdea08e08d0c8346d9dbc, length 71)
CREATE FUNCTION public.get_driver_user_id(p_driver_profile_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT user_id FROM driver_profiles WHERE id = p_driver_profile_id;
$function$;

-- Stubs with the live signatures
CREATE FUNCTION public.check_driver_eligibility(p_driver_id uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $f$ SELECT true $f$;
CREATE FUNCTION public.driver_can_afford_commission(p_driver_id uuid, p_estimated_fare_cup integer)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $f$ SELECT jsonb_build_object('ok', true, 'balance_cup', 1234) $f$;
CREATE FUNCTION public.find_best_drivers(p_pickup_lat double precision, p_pickup_lng double precision,
  p_service_type text, p_limit integer DEFAULT 10, p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false, p_estimated_trip_distance_m integer DEFAULT NULL,
  p_package_category text DEFAULT NULL, p_estimated_weight_kg numeric DEFAULT NULL,
  p_package_length_cm integer DEFAULT NULL, p_package_width_cm integer DEFAULT NULL,
  p_package_height_cm integer DEFAULT NULL, p_corporate_account_id uuid DEFAULT NULL)
 RETURNS TABLE(id uuid, user_id uuid, distance_m double precision)
 LANGUAGE sql SECURITY DEFINER
 AS $f$ SELECT 'd0000000-0000-4000-8000-000000000001'::uuid, 'a0000000-0000-4000-8000-000000000002'::uuid, 812.5::double precision $f$;
CREATE FUNCTION public._waypoint_pricing(p_ride_id uuid, p_extra_lat double precision DEFAULT NULL, p_extra_lng double precision DEFAULT NULL)
 RETURNS TABLE(path_road_m integer, extra_road_m integer, surcharge_cup integer)
 LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 4200, 300, 90 $f$;
CREATE FUNCTION public.can_send_sms(p_user_id uuid, p_max_per_hour integer DEFAULT 5)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $f$ SELECT true $f$;
CREATE FUNCTION public.driver_no_gps_rides_this_week(p_driver_id uuid)
 RETURNS integer LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 0 $f$;

-- Two functions 00610 must leave alone (the apps call them)
CREATE FUNCTION public.calculate_cancellation_fee(p_ride_id uuid, p_canceled_by uuid)
 RETURNS TABLE(fee_cup integer, fee_trc integer, fee_reason text, is_free boolean)
 LANGUAGE sql SECURITY DEFINER AS $f$ SELECT 0, 0, 'free_cancel'::text, true $f$;
CREATE FUNCTION public.check_accept_ride_eligibility(p_driver_id uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $f$ SELECT true $f$;

-- LIVE proacl on 2026-10-06
GRANT EXECUTE ON FUNCTION public._waypoint_pricing(uuid, double precision, double precision) TO service_role;
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'public.get_driver_user_id(uuid)', 'public.check_driver_eligibility(uuid)',
    'public.driver_can_afford_commission(uuid, integer)',
    'public.find_best_drivers(double precision, double precision, text, integer, integer, boolean, integer, text, numeric, integer, integer, integer, uuid)',
    'public.can_send_sms(uuid, integer)', 'public.driver_no_gps_rides_this_week(uuid)',
    'public.calculate_cancellation_fee(uuid, uuid)', 'public.check_accept_ride_eligibility(uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', s);
  END LOOP;
END $$;

-- The SECURITY DEFINER callers, executable by signed-in users like the real ones
CREATE FUNCTION public.zz_dispatch_like() RETURNS integer
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
 AS $f$ SELECT count(*)::integer FROM public.find_best_drivers(23.13, -82.36, 'triciclo_basico') $f$;
CREATE FUNCTION public.zz_accept_like() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
 AS $f$ SELECT (public.driver_can_afford_commission('d0000000-0000-4000-8000-000000000001', 2000) ->> 'ok')::boolean $f$;
CREATE FUNCTION public.zz_trigger_like() RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
 AS $f$ SELECT public.get_driver_user_id('d0000000-0000-4000-8000-000000000001')::text
           || '|' || public.can_send_sms('a0000000-0000-4000-8000-000000000002', 5)::text
           || '|' || (SELECT surcharge_cup FROM public._waypoint_pricing(gen_random_uuid()))::text $f$;
REVOKE ALL ON FUNCTION public.zz_dispatch_like(), public.zz_accept_like(), public.zz_trigger_like() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zz_dispatch_like(), public.zz_accept_like(), public.zz_trigger_like() TO authenticated;

RESET ROLE;
