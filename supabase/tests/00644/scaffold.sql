-- Scaffold for the 00644 rehearsal: vehicles with prod's columns, grants and
-- its four LIVE policies (2026-10-08), plus the minimum of users,
-- driver_profiles and rides those policies read, with the LIVE auth.uid(),
-- current_user_role() and is_admin() (00592). Policies on driver_profiles and
-- rides are the live own-row ones the vehicles policies go through.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

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
  role public.user_role NOT NULL DEFAULT 'customer'
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.users TO anon, authenticated, service_role;

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
  user_id uuid
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)) OR is_admin());
GRANT ALL ON public.driver_profiles TO anon, authenticated, service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  driver_id uuid,
  status public.ride_status NOT NULL DEFAULT 'searching'
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING (((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY r_select_driver ON public.rides FOR SELECT USING ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
GRANT ALL ON public.rides TO anon, authenticated, service_role;

-- vehicles: prod's columns, grants and policies.
CREATE TABLE public.vehicles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id uuid NOT NULL,
  type public.vehicle_type NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL,
  color text NOT NULL,
  plate_number text NOT NULL,
  capacity integer NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true,
  photo_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  max_cargo_length_cm integer,
  max_cargo_width_cm integer,
  max_cargo_height_cm integer,
  accepted_cargo_categories text[] DEFAULT '{}'::text[],
  accepts_cargo boolean DEFAULT false,
  max_cargo_weight_kg numeric
);
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.vehicles TO anon, authenticated, service_role;
CREATE POLICY v_admin_select ON public.vehicles FOR SELECT USING (is_admin());
CREATE POLICY v_insert ON public.vehicles FOR INSERT WITH CHECK ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY v_select ON public.vehicles FOR SELECT USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR ((( SELECT auth.uid() AS uid) IS NOT NULL) AND (is_active = true)) OR is_admin()));
CREATE POLICY v_update ON public.vehicles FOR UPDATE USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));

RESET ROLE;
