-- Scaffold for the 00628 rehearsal (support-assisted matching).
-- Prod's tables as of 2026-10-07, reduced to the columns the code under test reads, and the
-- LIVE bodies of the functions around rides and ride_offers (live-bodies.sql, dumped from prod;
-- run.sh checks every body against prod's md5).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST, net.http_post records
-- its calls in net.calls instead of sending them, and cron is a stub with pg_cron's job table.
-- Every object belongs to a NON-superuser role named postgres, as in prod: dispatch_ride lets
-- through callers whose current_user is 'postgres', and the migration is applied as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE EXTENSION IF NOT EXISTS postgis;  -- in public, as in prod

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA net AUTHORIZATION postgres;
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE SCHEMA cron AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- pg_cron stub: the job table and schedule(), which upserts by name like pg_cron does.
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text UNIQUE
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$f$;

-- pg_net stub: same signature, records the call instead of sending it.
CREATE TABLE net.calls (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net.calls (url, headers, body) VALUES ($1, $4, $2) RETURNING id
$f$;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.pricing_snapshot_type AS ENUM ('estimate', 'final');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  phone text,
  email text,
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  level public.user_level NOT NULL DEFAULT 'bronce',
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_active boolean NOT NULL DEFAULT true);

-- driver_profiles: every prod column (find_best_drivers and the offer triggers read many of them).
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean NOT NULL DEFAULT false,
  current_location geography,
  current_heading numeric,
  rating_avg numeric NOT NULL DEFAULT 5.00,
  total_rides integer NOT NULL DEFAULT 0,
  total_rides_completed integer NOT NULL DEFAULT 0,
  zone_id uuid,
  approved_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_financially_eligible boolean DEFAULT true,
  negative_balance_since timestamptz,
  match_score numeric DEFAULT 50.0,
  acceptance_rate numeric DEFAULT 100.0,
  total_rides_offered integer DEFAULT 0,
  custom_per_km_rate_cup integer,
  city_id uuid,
  is_on_break boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz DEFAULT now(),
  identity_number text,
  address text,
  province text,
  municipality text,
  has_criminal_record boolean DEFAULT false,
  criminal_record_details text,
  auto_accept_enabled boolean DEFAULT false,
  grace_trips_remaining integer DEFAULT 0,
  quota_blocked boolean DEFAULT false,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  terms_accepted_at timestamptz,
  auto_offline_at timestamptz
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id),
  type public.vehicle_type NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL,
  color text NOT NULL,
  plate_number text NOT NULL,
  capacity integer NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  max_cargo_length_cm integer,
  max_cargo_width_cm integer,
  max_cargo_height_cm integer,
  accepted_cargo_categories text[] DEFAULT '{}'::text[],
  accepts_cargo boolean DEFAULT false,
  max_cargo_weight_kg numeric
);

-- rides: every prod column, with prod's defaults and NOT NULLs.
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid,
  service_type text NOT NULL,
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  pickup_location geography NOT NULL,
  pickup_address text NOT NULL,
  dropoff_location geography NOT NULL,
  dropoff_address text NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  estimated_duration_s integer NOT NULL DEFAULT 0,
  final_fare_cup integer,
  actual_distance_m integer,
  actual_duration_s integer,
  scheduled_at timestamptz,
  is_scheduled boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  driver_arrived_at timestamptz,
  pickup_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid,
  cancellation_reason text,
  share_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  promo_code_id uuid,
  discount_amount_cup integer NOT NULL DEFAULT 0,
  surge_multiplier numeric NOT NULL DEFAULT 1.0,
  tip_amount integer NOT NULL DEFAULT 0,
  driver_custom_rate_cup integer,
  exchange_rate_usd_cup numeric,
  estimated_fare_trc integer,
  final_fare_trc integer,
  next_ride_id uuid,
  is_chained boolean DEFAULT false,
  scheduled_notified boolean DEFAULT false,
  city_id uuid,
  insurance_selected boolean NOT NULL DEFAULT false,
  insurance_premium_cup integer NOT NULL DEFAULT 0,
  rider_preferences jsonb,
  corporate_account_id uuid,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_lat double precision,
  dropoff_lng double precision,
  ride_mode text NOT NULL DEFAULT 'passenger',
  estimated_duration_hours numeric,
  payment_status text NOT NULL DEFAULT 'not_applicable',
  payment_intent_id uuid,
  cancellation_fee_cup numeric NOT NULL DEFAULT 0,
  cancellation_fee_trc numeric NOT NULL DEFAULT 0,
  passenger_count integer NOT NULL DEFAULT 1,
  wait_time_seconds integer DEFAULT 0,
  wait_charge_cup numeric DEFAULT 0,
  is_split boolean DEFAULT false,
  arrived_at_destination_at timestamptz,
  wallet_ratio numeric DEFAULT 0,
  wallet_amount_cup integer DEFAULT 0,
  cash_amount_cup integer DEFAULT 0,
  dispatch_round integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamptz,
  share_token_expires_at timestamptz,
  wait_time_minutes integer NOT NULL DEFAULT 0,
  wait_time_charge_cup integer NOT NULL DEFAULT 0,
  proximity_pickup_notified_at timestamptz,
  proximity_dropoff_notified_at timestamptz,
  quota_deduction_amount integer DEFAULT 0,
  excess_distance_uncharged_m integer NOT NULL DEFAULT 0,
  excess_distance_reason text,
  excess_distance_admin_reviewed boolean NOT NULL DEFAULT false,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz,
  no_gps_validation boolean NOT NULL DEFAULT false,
  gps_check_distance_m integer,
  driver_gps_status public.driver_gps_status NOT NULL DEFAULT 'healthy',
  driver_gps_unavailable_at timestamptz,
  rider_gps_consent_at timestamptz,
  delivery_recipient_notified_at timestamptz,
  searching_seen_at timestamptz NOT NULL DEFAULT now(),
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  cancellation_reason_code text,
  completed_far_from_pin boolean NOT NULL DEFAULT false,
  actual_dropoff_location geography,
  reported_distance_m integer,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  pickup_notes text,
  dropoff_notes text
);
CREATE UNIQUE INDEX rides_one_active_per_driver ON public.rides (driver_id)
  WHERE status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination');

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'superseded')),
  composite_score numeric,
  distance_m double precision,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (ride_id, driver_profile_id)
);

CREATE TABLE public.ride_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type public.pricing_snapshot_type NOT NULL,
  base_fare integer NOT NULL,
  per_km_rate integer NOT NULL,
  per_minute_rate integer NOT NULL,
  distance_m integer NOT NULL,
  duration_s integer NOT NULL,
  surge_multiplier numeric NOT NULL DEFAULT 1.00,
  subtotal integer NOT NULL,
  commission_rate numeric NOT NULL DEFAULT 0.150,
  commission_amount integer NOT NULL DEFAULT 0,
  total integer NOT NULL,
  pricing_rule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  exchange_rate_usd_cup numeric,
  total_trc integer,
  min_fare integer,
  corporate_commission_rate numeric,
  default_commission_rate_snapshot numeric,
  pre_waypoints_total integer,
  CONSTRAINT rps_surge_multiplier_min1 CHECK (surge_multiplier IS NULL OR surge_multiplier >= 1)
);

CREATE TABLE public.ride_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  sort_order integer NOT NULL,
  location geography NOT NULL,
  address text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.service_type_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_es text NOT NULL,
  name_en text NOT NULL,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  max_passengers integer NOT NULL DEFAULT 2,
  icon_name text NOT NULL DEFAULT 'car',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  time_window_start time,
  time_window_end time,
  day_of_week integer[],
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_promo_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL,
  ride_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  promo_code_id uuid,
  discount_amount_cup_supplied integer NOT NULL,
  estimated_fare_cup integer,
  notes text
);

CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname text NOT NULL,
  url text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0
);

CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL,
  commission_percent numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false
);
CREATE TABLE public.driver_fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  name text NOT NULL
);
CREATE TABLE public.fleet_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL,
  driver_id uuid,
  driver_name text NOT NULL,
  driver_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending_review'
);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  first_ride_only boolean NOT NULL DEFAULT false
);
CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL,
  user_id uuid NOT NULL,
  ride_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location geography NOT NULL,
  radius_m integer NOT NULL DEFAULT 80,
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  discount_percent numeric NOT NULL DEFAULT 10
);

CREATE TABLE public.customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rating_avg numeric NOT NULL DEFAULT 5.00
);

CREATE TABLE public.user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL
);

CREATE TABLE public.delivery_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  package_category text,
  estimated_weight_kg numeric,
  package_length_cm integer,
  package_width_cm integer,
  package_height_cm integer
);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
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

CREATE TABLE public.trip_insurance_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  premium_pct numeric NOT NULL DEFAULT 0.0500,
  min_premium_cup integer NOT NULL DEFAULT 50,
  is_active boolean NOT NULL DEFAULT true
);

-- Stub: prod reads the key from the vault.
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $f$ SELECT 'test-service-key'::text $f$;

-- LIVE bodies, dumped from prod (Task 1, step 4). auth.uid, current_user_role and
-- is_super_admin come first: SQL functions are checked when created.
\ir live-bodies.sql

CREATE TRIGGER rides_create_estimate_snapshot AFTER INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_create_estimate_snapshot();
CREATE TRIGGER rides_sync_coords_trg BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.rides_sync_coords();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup,
  shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_promo_discount();
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_update_columns();
CREATE TRIGGER trg_rides_validate_insurance BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_insurance();
CREATE TRIGGER ride_offers_increment_offered AFTER INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_offer_increment_offered();
CREATE TRIGGER ride_offers_refresh_acceptance AFTER UPDATE OF status ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_offer_refresh_acceptance();
CREATE TRIGGER trg_notify_driver_new_offer AFTER INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.notify_driver_new_offer();
CREATE TRIGGER trg_notify_driver_reoffer AFTER UPDATE OF status ON public.ride_offers
  FOR EACH ROW WHEN (old.status = 'expired' AND new.status = 'pending') EXECUTE FUNCTION public.notify_driver_new_offer();

-- Seeds -------------------------------------------------------------------------------------
INSERT INTO public.platform_config (key, value) VALUES
  ('commission_rate', '0.15'), ('offer_ttl_seconds', '60'), ('reoffer_cooldown_s', '120'),
  ('dispatch_stage1_seconds', '45'), ('dispatch_stage1_radius_m', '8000'), ('dispatch_max_radius_m', '50000'),
  ('dispatch_offer_limit', '0'), ('dispatch_heartbeat_window_s', '0'), ('low_rating_rider_threshold', '3.0'),
  ('shared_ride_discount_per_seat_pct', '7'),
  ('business_notification_email', '"ops@tricigo.test, jefa@tricigo.test"');

INSERT INTO public.valid_transitions VALUES
  ('searching', 'accepted', '{driver,admin,super_admin}'),
  ('searching', 'canceled', '{customer,admin,super_admin}');

INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, is_active) VALUES
  ('triciclo_basico', 'Triciclo', 'Tricycle', 500, 150, 10, 1337, 4, true),
  ('moto_standard', 'Moto', 'Moto', 300, 90, 6, 620, 1, true),
  ('auto_standard', 'Auto', 'Car', 700, 200, 12, 1551, 4, true),
  ('auto_confort', 'Confort', 'Comfort', 900, 260, 15, 2011, 4, true),
  ('mensajeria', 'Mensajería', 'Delivery', 800, 200, 10, 2038, 0, true),
  ('triciclo_premium', 'Triciclo premium', 'Premium tricycle', 900, 250, 15, 4786, 8, false);
INSERT INTO public.pricing_rules (service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup)
  SELECT slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup FROM public.service_type_configs;

INSERT INTO public.users (id, full_name, phone, role, is_test) VALUES
  ('a0000000-0000-4000-8000-0000000000ad', 'Ana Admin', '+5350000001', 'admin', false),
  ('a0000000-0000-4000-8000-0000000000ee', 'Sergio Super', '+5350000002', 'super_admin', false),
  ('c0000000-0000-4000-8000-000000000001', 'Rita Rider', '+5350000101', 'customer', false),
  ('c0000000-0000-4000-8000-000000000002', 'Oscar Otro', '+5350000102', 'customer', false),
  ('c0000000-0000-4000-8000-000000000003', 'Tina Test', '+5350000103', 'customer', true),
  ('e1000000-0000-4000-8000-000000000001', 'Daniel Uno', '+5350000201', 'driver', false),
  ('e2000000-0000-4000-8000-000000000002', 'Daniel Dos', '+5350000202', 'driver', false),
  ('e3000000-0000-4000-8000-000000000003', 'Daniel Tres', '+5350000203', 'driver', false),
  ('e4000000-0000-4000-8000-000000000004', 'Daniel Cuatro', '+5350000204', 'driver', false),
  ('e5000000-0000-4000-8000-000000000005', 'Daniel Cinco', '+5350000205', 'driver', false),
  ('e6000000-0000-4000-8000-000000000006', 'Daniel Seis', '+5350000206', 'driver', false),
  ('e7000000-0000-4000-8000-000000000007', 'Daniel Siete', '+5350000207', 'driver', false),
  ('e8000000-0000-4000-8000-000000000008', 'Daniel Ocho', '+5350000208', 'driver', false);
INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES
  ('c0000000-0000-4000-8000-000000000001', 4.8),
  ('c0000000-0000-4000-8000-000000000002', 4.8),
  ('c0000000-0000-4000-8000-000000000003', 4.8);

-- Pickup of every test ride: (-82.3830, 23.1330). Distances along the same latitude.
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, last_heartbeat_at) VALUES
  -- D1 triciclo, online, ~307 m
  ('d1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3800, 23.1330), 4326)::geography, now()),
  -- D2 moto, online, ~512 m
  ('d2000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3780, 23.1330), 4326)::geography, now()),
  -- D3 triciclo, offline since 2 days, ~1 km
  ('d3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000003', 'approved', false,
   ST_SetSRID(ST_MakePoint(-82.3732, 23.1330), 4326)::geography, now() - interval '2 days'),
  -- D4 triciclo, online, busy with RB, ~800 m
  ('d4000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000004', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3752, 23.1330), 4326)::geography, now()),
  -- D5 auto, online, ~563 m
  ('d5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000005', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3775, 23.1330), 4326)::geography, now()),
  -- D6 triciclo, online, no balance, ~389 m
  ('d6000000-0000-4000-8000-000000000006', 'e6000000-0000-4000-8000-000000000006', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3792, 23.1330), 4326)::geography, now()),
  -- D7 triciclo, still in verification
  ('d7000000-0000-4000-8000-000000000007', 'e7000000-0000-4000-8000-000000000007', 'pending_verification', false,
   ST_SetSRID(ST_MakePoint(-82.3810, 23.1330), 4326)::geography, now()),
  -- D8 triciclo, online but its last heartbeat is 10 minutes old, ~451 m
  ('d8000000-0000-4000-8000-000000000008', 'e8000000-0000-4000-8000-000000000008', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3786, 23.1330), 4326)::geography, now() - interval '10 minutes');
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number) VALUES
  ('d1000000-0000-4000-8000-000000000001', 'triciclo', 'Bicitaxi', 'Clásico', 2020, 'Rojo', 'T-0001'),
  ('d2000000-0000-4000-8000-000000000002', 'moto', 'Suzuki', 'GN125', 2018, 'Negra', 'M-0002'),
  ('d3000000-0000-4000-8000-000000000003', 'triciclo', 'Bicitaxi', 'Clásico', 2019, 'Azul', 'T-0003'),
  ('d4000000-0000-4000-8000-000000000004', 'triciclo', 'Bicitaxi', 'Clásico', 2021, 'Verde', 'T-0004'),
  ('d5000000-0000-4000-8000-000000000005', 'auto', 'Lada', '2107', 1988, 'Blanco', 'A-0005'),
  ('d6000000-0000-4000-8000-000000000006', 'triciclo', 'Bicitaxi', 'Clásico', 2022, 'Amarillo', 'T-0006'),
  ('d7000000-0000-4000-8000-000000000007', 'triciclo', 'Bicitaxi', 'Clásico', 2023, 'Gris', 'T-0007'),
  ('d8000000-0000-4000-8000-000000000008', 'triciclo', 'Bicitaxi', 'Clásico', 2020, 'Blanco', 'T-0008');
INSERT INTO public.wallet_accounts (user_id, account_type, balance)
  SELECT user_id, 'tricicoin', CASE WHEN id = 'd6000000-0000-4000-8000-000000000006' THEN 0 ELSE 50000 END
  FROM public.driver_profiles;

-- RB: Oscar's ride, accepted by D4 (keeps D4 busy).
INSERT INTO public.rides (id, customer_id, driver_id, service_type, status, pickup_location, pickup_address,
  dropoff_location, dropoff_address, estimated_fare_cup, estimated_fare_trc, estimated_distance_m,
  estimated_duration_s, accepted_at) VALUES
  ('fb000000-0000-4000-8000-0000000000bb', 'c0000000-0000-4000-8000-000000000002',
   'd4000000-0000-4000-8000-000000000004', 'triciclo_basico', 'accepted',
   ST_SetSRID(ST_MakePoint(-82.3700, 23.1300), 4326)::geography, 'Línea y G',
   ST_SetSRID(ST_MakePoint(-82.3650, 23.1320), 4326)::geography, 'Paseo y 23', 1500, 1500, 1200, 300, now());

INSERT INTO public.promotions (id, code, type, discount_percent, valid_from) VALUES
  ('9a000000-0000-4000-8000-000000000025', 'BACO25', 'percentage_discount', 25, now() - interval '1 day');

INSERT INTO public.corporate_accounts (id, name, status, created_by) VALUES
  ('c0c00000-0000-4000-8000-000000000001', 'Empresa Uno', 'approved', 'c0000000-0000-4000-8000-000000000002');

RESET ROLE;
