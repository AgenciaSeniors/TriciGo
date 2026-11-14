-- Tables and enums as in prod on 2026-11-07 (information_schema): users, driver_profiles and rides
-- as in supabase/tests/00671/tables.sql (same columns today), with the NOT NULL and defaults 00679
-- reads; admin_actions, ride_assist, platform_config and rpc_attempt_log as in prod;
-- service_type_configs reduced to what _ride_type_label reads. PostGIS types become text. No
-- triggers and no RLS on these: the cases exercise the 00679 functions and support_staff's policy.
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');

CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  phone text,
  email text,
  full_name text NOT NULL DEFAULT ''::text,
  role public.user_role NOT NULL DEFAULT 'customer'::public.user_role,
  avatar_url text,
  preferred_language text NOT NULL DEFAULT 'es'::text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  level public.user_level NOT NULL DEFAULT 'bronce'::public.user_level,
  total_rides integer NOT NULL DEFAULT 0,
  total_spent integer NOT NULL DEFAULT 0,
  cancellation_count integer DEFAULT 0,
  last_cancellation_at timestamp with time zone,
  sms_notifications_enabled boolean DEFAULT true,
  city_id uuid,
  password_set_at timestamp with time zone,
  email_verified_at timestamp with time zone,
  is_test boolean NOT NULL DEFAULT false,
  marketing_opt_in boolean,
  marketing_opt_in_at timestamp with time zone,
  marketing_opt_in_source text,
  signup_code text,
  signup_code_at timestamp with time zone
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status public.driver_status NOT NULL DEFAULT 'pending_verification'::public.driver_status,
  is_online boolean NOT NULL DEFAULT false,
  current_location text,
  current_heading numeric,
  rating_avg numeric NOT NULL DEFAULT 5.00,
  total_rides integer NOT NULL DEFAULT 0,
  total_rides_completed integer NOT NULL DEFAULT 0,
  zone_id uuid,
  approved_at timestamp with time zone,
  suspended_at timestamp with time zone,
  suspended_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_financially_eligible boolean DEFAULT true,
  negative_balance_since timestamp with time zone,
  match_score numeric DEFAULT 50.0,
  acceptance_rate numeric DEFAULT 100.0,
  total_rides_offered integer DEFAULT 0,
  custom_per_km_rate_cup integer,
  city_id uuid,
  is_on_break boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamp with time zone DEFAULT now(),
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
  terms_accepted_at timestamp with time zone,
  auto_offline_at timestamp with time zone
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid,
  service_type text NOT NULL,
  status public.ride_status NOT NULL DEFAULT 'searching'::public.ride_status,
  payment_method public.payment_method NOT NULL DEFAULT 'cash'::public.payment_method,
  pickup_location text,
  pickup_address text NOT NULL,
  dropoff_location text,
  dropoff_address text NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  estimated_duration_s integer NOT NULL DEFAULT 0,
  final_fare_cup integer,
  actual_distance_m integer,
  actual_duration_s integer,
  scheduled_at timestamp with time zone,
  is_scheduled boolean NOT NULL DEFAULT false,
  accepted_at timestamp with time zone,
  driver_arrived_at timestamp with time zone,
  pickup_at timestamp with time zone,
  completed_at timestamp with time zone,
  canceled_at timestamp with time zone,
  canceled_by uuid,
  cancellation_reason text,
  share_token text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
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
  ride_mode text NOT NULL DEFAULT 'passenger'::text,
  estimated_duration_hours numeric,
  payment_status text NOT NULL DEFAULT 'not_applicable'::text,
  payment_intent_id uuid,
  cancellation_fee_cup numeric NOT NULL DEFAULT 0,
  cancellation_fee_trc numeric NOT NULL DEFAULT 0,
  passenger_count integer NOT NULL DEFAULT 1,
  wait_time_seconds integer DEFAULT 0,
  wait_charge_cup numeric DEFAULT 0,
  is_split boolean DEFAULT false,
  arrived_at_destination_at timestamp with time zone,
  wallet_ratio numeric DEFAULT 0,
  wallet_amount_cup integer DEFAULT 0,
  cash_amount_cup integer DEFAULT 0,
  dispatch_round integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamp with time zone,
  share_token_expires_at timestamp with time zone,
  wait_time_minutes integer NOT NULL DEFAULT 0,
  wait_time_charge_cup integer NOT NULL DEFAULT 0,
  proximity_pickup_notified_at timestamp with time zone,
  proximity_dropoff_notified_at timestamp with time zone,
  quota_deduction_amount integer DEFAULT 0,
  excess_distance_uncharged_m integer NOT NULL DEFAULT 0,
  excess_distance_reason text,
  excess_distance_admin_reviewed boolean NOT NULL DEFAULT false,
  gps_override_requested_at timestamp with time zone,
  gps_override_confirmed_at timestamp with time zone,
  no_gps_validation boolean NOT NULL DEFAULT false,
  gps_check_distance_m integer,
  driver_gps_status public.driver_gps_status NOT NULL DEFAULT 'healthy'::public.driver_gps_status,
  driver_gps_unavailable_at timestamp with time zone,
  rider_gps_consent_at timestamp with time zone,
  delivery_recipient_notified_at timestamp with time zone,
  searching_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  cancellation_reason_code text,
  completed_far_from_pin boolean NOT NULL DEFAULT false,
  actual_dropoff_location text,
  reported_distance_m integer,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  pickup_notes text,
  dropoff_notes text
);

CREATE TABLE public.ride_assist (
  ride_id uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  help_requested_at timestamp with time zone,
  help_alert_sent_at timestamp with time zone,
  wait_alert_sent_at timestamp with time zone,
  help_email_sent_at timestamp with time zone,
  wait_email_sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.service_type_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_es text NOT NULL,
  name_en text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

-- ride_assist as in prod: RLS on, the owner and service_role only.
ALTER TABLE public.ride_assist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ride_assist FROM anon, authenticated;

-- ── Part 3: what the seven assist actions, the two contexts and the banner read ──
-- As in prod on 2026-11-09 (information_schema), reduced to the columns those bodies use; PostGIS
-- types become text.
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  driver_profile_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  composite_score numeric,
  distance_m double precision,
  offered_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  responded_at timestamp with time zone
);

CREATE TABLE public.ride_service_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  from_service_type text NOT NULL,
  to_service_type text NOT NULL,
  from_fare_cup integer NOT NULL,
  to_fare_cup integer NOT NULL,
  proposed_by uuid,
  status text NOT NULL DEFAULT 'pending'::text,
  expires_at timestamp with time zone NOT NULL,
  responded_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.stuck_ride_alerts (
  ride_id uuid NOT NULL,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  emailed_at timestamp with time zone,
  resolved_at timestamp with time zone
);

CREATE TABLE public.delivery_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  delivery_photo_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  delivery_otp_validated_at timestamp with time zone
);

CREATE TABLE public.ride_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  location text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  type public.vehicle_type NOT NULL,
  make text NOT NULL,
  model text NOT NULL,
  color text NOT NULL,
  plate_number text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ride_location_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  location text NOT NULL,
  recorded_at timestamp with time zone NOT NULL DEFAULT now(),
  received_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  is_fleet_owner boolean NOT NULL DEFAULT false
);

CREATE TABLE public.driver_fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.fleet_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL,
  driver_id uuid,
  status text NOT NULL DEFAULT 'pending_review'::text
);

-- Stubs of what those bodies call and 00679 does not touch, with prod's signatures (as the 00671
-- and 00677 rehearsals): no PostGIS, no dispatch, no wallets. The service change writes the new
-- type and fare, and complete_ride_and_pay only closes the ride, so the owner's path (C1b) can be
-- followed to the end.
CREATE FUNCTION public.ST_Distance(a text, b text) RETURNS double precision
  LANGUAGE sql IMMUTABLE AS $f$ SELECT 0::double precision $f$;
CREATE FUNCTION public._driver_can_serve_ride(p_dp uuid, p_svc text, p_cargo boolean) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT true $f$;
CREATE FUNCTION public._users_blocked(p_a uuid, p_b uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE FUNCTION public.driver_can_afford_commission(p_driver_id uuid, p_estimated_fare_cup integer) RETURNS jsonb
  LANGUAGE sql AS $f$ SELECT '{"ok": true}'::jsonb $f$;
CREATE FUNCTION public._ride_service_change_error(p_ride public.rides, p_service_type text, p_fare_cup integer)
  RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
CREATE FUNCTION public._apply_ride_service_change(p_ride_id uuid, p_service_type text, p_fare_cup integer)
  RETURNS void LANGUAGE sql AS
$f$ UPDATE public.rides SET service_type = p_service_type, estimated_fare_cup = p_fare_cup WHERE id = p_ride_id $f$;
CREATE FUNCTION public._reopen_ride_offers(p_ride_id uuid, p_driver_id uuid) RETURNS integer
  LANGUAGE sql AS $f$ SELECT 0 $f$;
CREATE FUNCTION public._support_ride_push(p_rpc text, p_ride_id uuid, p_user_id uuid, p_title text, p_body text,
                                          p_category text, p_data jsonb) RETURNS void
  LANGUAGE sql AS $f$ SELECT $f$;
CREATE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000) RETURNS jsonb
  LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
CREATE FUNCTION public._ride_gps_departure_at(p_ride_id uuid, p_arrived_at timestamp with time zone)
  RETURNS timestamp with time zone LANGUAGE sql STABLE AS $f$ SELECT NULL::timestamptz $f$;
CREATE FUNCTION public._wait_charge_for(p_service_type text, p_arrived_at timestamp with time zone,
  p_pickup_at timestamp with time zone, OUT wait_minutes integer, OUT billable_minutes integer, OUT charge integer)
  LANGUAGE sql STABLE AS $f$ SELECT 0, 0, 0 $f$;
CREATE FUNCTION public._active_ride_charge_preview(p_ride public.rides, p_start timestamp with time zone)
  RETURNS jsonb LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('total_cup', COALESCE(p_ride.estimated_fare_cup, 0)) $f$;
CREATE FUNCTION public.complete_ride_and_pay(p_ride_id uuid, p_driver_id uuid, p_actual_distance_m integer,
                                             p_actual_duration_s integer) RETURNS jsonb
  LANGUAGE sql AS $f$
  UPDATE public.rides SET status = 'completed', completed_at = now(), final_fare_cup = COALESCE(estimated_fare_cup, 0)
   WHERE id = p_ride_id;
  SELECT '{}'::jsonb
$f$;
