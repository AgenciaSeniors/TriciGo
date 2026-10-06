-- Scaffold for the 00621 rehearsal: the tables the pulse and the incomplete-driver
-- view read, with only the columns they touch, prod's RLS on users, the live
-- auth.uid() and is_admin() (00592), and a stand-in for pg_cron (cron.job +
-- schedule/unschedule). A NON-superuser role (prod: postgres) owns everything;
-- run.sh applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS cron;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER SCHEMA cron OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.document_type AS ENUM ('national_id', 'drivers_license', 'vehicle_registration',
  'selfie', 'vehicle_photo', 'operating_license');

-- pg_cron stand-in: schedule upserts by name, as pg_cron 1.6 does.
CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
CREATE FUNCTION cron.schedule(p_name text, p_schedule text, p_command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid::bigint
$$;
CREATE FUNCTION cron.unschedule(p_name text) RETURNS boolean
LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true $$;

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid LANGUAGE sql STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

CREATE TABLE auth.users (id uuid PRIMARY KEY, last_sign_in_at timestamptz);

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  phone text,
  is_test boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  signup_code text,
  marketing_opt_in boolean,
  marketing_opt_in_at timestamptz
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

-- LIVE current_user_role() / is_admin() (00592).
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean LANGUAGE plpgsql STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN current_user_role() IN ('admin', 'super_admin');
END;
$function$;

CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid)));

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id),
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean NOT NULL DEFAULT false,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  document_type public.document_type NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  rejection_reason text
);
CREATE TABLE public.driver_heartbeat_log (
  driver_profile_id uuid NOT NULL,
  beat_at timestamptz NOT NULL DEFAULT now(),
  is_online boolean NOT NULL
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id)
);
CREATE TABLE public.user_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  push_token text NOT NULL
);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid REFERENCES public.users(id),
  referee_id uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz
);

-- Prod until 2026-10-30: every new public table is granted to the API roles by
-- default. The migration must take back what it does not want them to have.
ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

RESET ROLE;
