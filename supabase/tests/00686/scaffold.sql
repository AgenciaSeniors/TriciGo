-- Scaffold for the 00686 rehearsal: only what the dead-driver release, the
-- reclaim and the triggers they fire touch. Columns and types copied from prod
-- (2026-11-18). No PostGIS: geography is a text domain and ST_SetSRID /
-- ST_MakePoint are stubs, because nothing here measures a distance.
SET client_min_messages = warning;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;

CREATE DOMAIN public.geography AS text;
CREATE FUNCTION public.st_makepoint(double precision, double precision) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT format('POINT(%s %s)', $1, $2) $$;
CREATE FUNCTION public.st_setsrid(text, integer) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable');
CREATE TYPE public.payment_method AS ENUM ('cash', 'tricicoin', 'mixed', 'corporate');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users (id),
  status text NOT NULL DEFAULT 'approved',
  is_online boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz,
  auto_offline_at timestamptz,
  current_location public.geography,
  current_heading double precision,
  custom_per_km_rate_cup integer
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles (id),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users (id),
  driver_id uuid REFERENCES public.driver_profiles (id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  pickup_location public.geography,
  dropoff_location public.geography,
  pickup_address text,
  dropoff_address text,
  pickup_notes text,
  dropoff_notes text,
  estimated_fare_cup integer,
  estimated_fare_trc integer,
  estimated_distance_m integer,
  estimated_duration_s integer,
  final_fare_cup integer,
  final_fare_trc integer,
  cancellation_fee_cup integer,
  cancellation_fee_trc integer,
  accepted_at timestamptz,
  driver_arrived_at timestamptz,
  pickup_at timestamptz,
  arrived_at_destination_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  actual_distance_m integer,
  actual_duration_s integer,
  surge_multiplier numeric DEFAULT 1,
  driver_custom_rate_cup integer,
  wallet_ratio numeric,
  insurance_premium_cup integer,
  wait_time_charge_cup integer,
  searching_seen_at timestamptz,
  last_dispatched_at timestamptz,
  driver_gps_status public.driver_gps_status DEFAULT 'healthy',
  driver_gps_unavailable_at timestamptz,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz,
  gps_check_distance_m integer,
  proximity_pickup_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX rides_one_active_per_driver ON public.rides (driver_id)
  WHERE driver_id IS NOT NULL
    AND status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination');

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides (id),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles (id),
  status text NOT NULL DEFAULT 'pending',
  composite_score numeric,
  distance_m double precision,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  responded_at timestamptz,
  UNIQUE (ride_id, driver_profile_id)
);

CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  from_status public.ride_status,
  to_status public.ride_status NOT NULL,
  actor_id uuid,
  actor_role public.user_role,
  reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
);

CREATE TABLE public.stuck_ride_alerts (
  ride_id uuid PRIMARY KEY,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  emailed_at timestamptz,
  resolved_at timestamptz
);

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ride_location_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  location public.geography NOT NULL,
  heading numeric,
  speed numeric,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  accuracy numeric,
  client_event_id uuid,
  received_at timestamptz DEFAULT now()
);
-- The background task inserts its points straight into the table (RLS is not
-- what this rehearsal is about; the guard trigger is).
GRANT INSERT, SELECT ON public.ride_location_events TO authenticated;

CREATE FUNCTION public.current_user_role() RETURNS public.user_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT role FROM public.users WHERE id = auth.uid() $$;
CREATE FUNCTION public._ops_acting_on(uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.get_service_role_key() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT ''::text $$;
CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb, body jsonb,
                                      timeout_milliseconds integer DEFAULT 30000)
  RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;

INSERT INTO public.platform_config (key, value) VALUES
  ('dead_driver_ride_release_enabled', 'true'::jsonb),
  ('dead_driver_ride_release_after_minutes', '12'::jsonb),
  ('driver_auto_restore_enabled', 'true'::jsonb),
  ('driver_auto_restore_window_min', '60'::jsonb),
  ('reoffer_cooldown_s', '120'::jsonb);
