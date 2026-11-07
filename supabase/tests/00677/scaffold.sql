-- Scaffold for the 00677 rehearsal (company rides need no wallet of their own).
-- Tables reduced to the columns the three patched functions read; PostGIS types become text
-- (ST_Distance is a stub). The function bodies under test are loaded from live-bodies.sql, dumped
-- from prod (pg_get_functiondef); run.sh checks their md5 against prod's before anything else.
-- Every object belongs to a NON-superuser role named postgres, as in prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO CURRENT_USER;
GRANT anon, authenticated, service_role TO postgres;
CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;
SET ROLE postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress',
  'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'corporate_cash', 'tricicoin', 'platform_revenue');

CREATE TABLE public.users (id uuid PRIMARY KEY, role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true, full_name text, phone text);
CREATE TABLE public.user_blocks (blocker_id uuid, blocked_id uuid);
CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.users(id),
  status public.driver_status NOT NULL DEFAULT 'approved', is_online boolean NOT NULL DEFAULT true,
  last_heartbeat_at timestamptz DEFAULT now(), current_location text, custom_per_km_rate_cup integer);
CREATE TABLE public.vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid, type public.vehicle_type,
  is_active boolean DEFAULT true, make text, model text, color text, plate_number text, accepts_cargo boolean,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.wallet_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  account_type public.wallet_account_type, balance integer NOT NULL DEFAULT 0);
CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, is_fleet_owner boolean NOT NULL DEFAULT false);
CREATE TABLE public.driver_fleets (id uuid PRIMARY KEY, corporate_account_id uuid);
CREATE TABLE public.fleet_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fleet_id uuid, driver_id uuid,
  status text);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, base_fare_cup integer, per_km_rate_cup integer,
  per_minute_rate_cup integer, min_fare_cup integer, is_active boolean DEFAULT true);
CREATE TABLE public.rides (id uuid PRIMARY KEY, customer_id uuid, driver_id uuid, status public.ride_status,
  service_type text, ride_mode text DEFAULT 'passenger', payment_method public.payment_method DEFAULT 'cash',
  corporate_account_id uuid, estimated_fare_cup integer, estimated_fare_trc integer, driver_custom_rate_cup integer,
  is_scheduled boolean, scheduled_at timestamptz, pickup_address text, pickup_location text, accepted_at timestamptz);
CREATE TABLE public.ride_offers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid, driver_profile_id uuid,
  status text, expires_at timestamptz, responded_at timestamptz);
CREATE TABLE public.ride_service_proposals (ride_id uuid, status text, responded_at timestamptz);
CREATE TABLE public.admin_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid, action text,
  target_type text, target_id text, old_values jsonb, new_values jsonb, reason text);
CREATE TABLE public.rpc_attempt_log (id bigserial PRIMARY KEY, rpc_name text, caller_uid uuid, target_id uuid,
  outcome text, metadata jsonb, created_at timestamptz DEFAULT now());

-- Role check (is_ops_staff is all the admin_* functions ask here).
CREATE FUNCTION public.is_ops_staff() RETURNS boolean LANGUAGE sql STABLE AS
$f$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin', 'operator')) $f$;
-- Stubs of what the patched functions call and 00677 does not touch.
CREATE FUNCTION public._ops_allow(p_ids uuid[]) RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION public._driver_can_serve_ride(p_dp uuid, p_svc text, p_cargo boolean) RETURNS boolean
  LANGUAGE sql AS $f$ SELECT true $f$;
CREATE FUNCTION public._vehicle_types_for_service(p_service_type text) RETURNS public.vehicle_type[]
  LANGUAGE sql IMMUTABLE AS $f$ SELECT NULL::public.vehicle_type[] $f$;
CREATE FUNCTION public.ST_Distance(a text, b text) RETURNS double precision LANGUAGE sql AS $f$ SELECT 0::double precision $f$;
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $f$ SELECT 'k'::text $f$;
CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000) RETURNS bigint LANGUAGE sql AS $f$ SELECT 1::bigint $f$;
