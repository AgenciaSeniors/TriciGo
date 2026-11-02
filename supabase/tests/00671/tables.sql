-- Tables, enums and valid_transitions as in prod on 2026-11-02 (columns only; PostGIS types become text).
CREATE TYPE public.document_type AS ENUM ('national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo', 'operating_license');

CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TYPE public.incident_severity AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE public.incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');

CREATE TYPE public.incident_type AS ENUM ('sos', 'safety_concern', 'payment_dispute', 'vehicle_issue', 'driver_behavior', 'passenger_behavior', 'review_abuse');

CREATE TYPE public.ledger_entry_type AS ENUM ('recharge', 'ride_payment', 'ride_hold', 'ride_hold_release', 'commission', 'transfer_in', 'transfer_out', 'promo_credit', 'redemption', 'adjustment', 'insurance_premium', 'refund', 'quota_deduction', 'quota_recharge', 'fx_revaluation');

CREATE TYPE public.ledger_transaction_status AS ENUM ('pending', 'posted', 'archived', 'reversed');

CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

CREATE TYPE public.pricing_snapshot_type AS ENUM ('estimate', 'final');

CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');

CREATE TYPE public.redemption_status AS ENUM ('requested', 'approved', 'processed', 'rejected');

CREATE TYPE public.referral_status AS ENUM ('pending', 'rewarded', 'invalidated');

CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');

CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');

CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue', 'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');

CREATE TYPE public.zone_type AS ENUM ('operational', 'surge', 'restricted');

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text,
  target_type text,
  target_id text,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  status public.driver_status,
  is_online boolean DEFAULT false,
  current_location text,
  current_heading numeric,
  rating_avg numeric(3,2),
  total_rides integer DEFAULT 0,
  total_rides_completed integer DEFAULT 0,
  zone_id uuid,
  approved_at timestamp with time zone,
  suspended_at timestamp with time zone,
  suspended_reason text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_financially_eligible boolean DEFAULT true,
  negative_balance_since timestamp with time zone,
  match_score numeric,
  acceptance_rate numeric,
  total_rides_offered integer DEFAULT 0,
  custom_per_km_rate_cup integer,
  city_id uuid,
  is_on_break boolean DEFAULT false,
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
  preferences jsonb,
  terms_accepted_at timestamp with time zone,
  auto_offline_at timestamp with time zone
);

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  driver_profile_id uuid,
  status text,
  composite_score numeric,
  distance_m double precision,
  offered_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  responded_at timestamp with time zone
);

CREATE TABLE public.ride_service_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  from_service_type text,
  to_service_type text,
  from_fare_cup integer,
  to_fare_cup integer,
  proposed_by uuid,
  status text,
  expires_at timestamp with time zone,
  responded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  from_status public.ride_status,
  to_status public.ride_status,
  actor_id uuid,
  actor_role public.user_role,
  reason text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  driver_id uuid,
  service_type text,
  status public.ride_status,
  payment_method public.payment_method,
  pickup_location text,
  pickup_address text,
  dropoff_location text,
  dropoff_address text,
  estimated_fare_cup integer DEFAULT 0,
  estimated_distance_m integer DEFAULT 0,
  estimated_duration_s integer DEFAULT 0,
  final_fare_cup integer,
  actual_distance_m integer,
  actual_duration_s integer,
  scheduled_at timestamp with time zone,
  is_scheduled boolean DEFAULT false,
  accepted_at timestamp with time zone,
  driver_arrived_at timestamp with time zone,
  pickup_at timestamp with time zone,
  completed_at timestamp with time zone,
  canceled_at timestamp with time zone,
  canceled_by uuid,
  cancellation_reason text,
  share_token text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  promo_code_id uuid,
  discount_amount_cup integer DEFAULT 0,
  surge_multiplier numeric,
  tip_amount integer DEFAULT 0,
  driver_custom_rate_cup integer,
  exchange_rate_usd_cup numeric,
  estimated_fare_trc integer,
  final_fare_trc integer,
  next_ride_id uuid,
  is_chained boolean DEFAULT false,
  scheduled_notified boolean DEFAULT false,
  city_id uuid,
  insurance_selected boolean DEFAULT false,
  insurance_premium_cup integer DEFAULT 0,
  rider_preferences jsonb,
  corporate_account_id uuid,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_lat double precision,
  dropoff_lng double precision,
  ride_mode text,
  estimated_duration_hours numeric(4,2),
  payment_status text,
  payment_intent_id uuid,
  cancellation_fee_cup numeric DEFAULT 0,
  cancellation_fee_trc numeric DEFAULT 0,
  passenger_count integer DEFAULT 1,
  wait_time_seconds integer DEFAULT 0,
  wait_charge_cup numeric DEFAULT 0,
  is_split boolean DEFAULT false,
  arrived_at_destination_at timestamp with time zone,
  wallet_ratio numeric(3,2) DEFAULT 0,
  wallet_amount_cup integer DEFAULT 0,
  cash_amount_cup integer DEFAULT 0,
  dispatch_round integer DEFAULT 0,
  last_dispatched_at timestamp with time zone,
  share_token_expires_at timestamp with time zone,
  wait_time_minutes integer DEFAULT 0,
  wait_time_charge_cup integer DEFAULT 0,
  proximity_pickup_notified_at timestamp with time zone,
  proximity_dropoff_notified_at timestamp with time zone,
  quota_deduction_amount integer DEFAULT 0,
  excess_distance_uncharged_m integer DEFAULT 0,
  excess_distance_reason text,
  excess_distance_admin_reviewed boolean DEFAULT false,
  gps_override_requested_at timestamp with time zone,
  gps_override_confirmed_at timestamp with time zone,
  no_gps_validation boolean DEFAULT false,
  gps_check_distance_m integer,
  driver_gps_status public.driver_gps_status,
  driver_gps_unavailable_at timestamp with time zone,
  rider_gps_consent_at timestamp with time zone,
  delivery_recipient_notified_at timestamp with time zone,
  searching_seen_at timestamp with time zone DEFAULT now(),
  shared_ride boolean DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer DEFAULT 0,
  cancellation_reason_code text,
  completed_far_from_pin boolean DEFAULT false,
  actual_dropoff_location text,
  reported_distance_m integer,
  partner_place_id uuid,
  partner_discount_cup integer DEFAULT 0,
  pickup_notes text,
  dropoff_notes text
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text,
  email text,
  full_name text,
  role public.user_role,
  avatar_url text,
  preferred_language text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  level public.user_level,
  total_rides integer DEFAULT 0,
  total_spent integer DEFAULT 0,
  cancellation_count integer DEFAULT 0,
  last_cancellation_at timestamp with time zone,
  sms_notifications_enabled boolean DEFAULT true,
  city_id uuid,
  password_set_at timestamp with time zone,
  email_verified_at timestamp with time zone,
  is_test boolean DEFAULT false,
  marketing_opt_in boolean,
  marketing_opt_in_at timestamp with time zone,
  marketing_opt_in_source text,
  signup_code text,
  signup_code_at timestamp with time zone
);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status,
  to_status public.ride_status,
  allowed_roles public.user_role[]
);

INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES ('searching', 'accepted', '{driver,admin,super_admin}'), ('searching', 'canceled', '{customer,admin,super_admin}'), ('accepted', 'searching', '{admin,super_admin}'), ('accepted', 'driver_en_route', '{driver,admin,super_admin}'), ('accepted', 'arrived_at_pickup', '{admin,super_admin}'), ('accepted', 'canceled', '{customer,driver,admin,super_admin}'), ('driver_en_route', 'searching', '{admin,super_admin}'), ('driver_en_route', 'arrived_at_pickup', '{driver,admin,super_admin}'), ('driver_en_route', 'canceled', '{customer,driver,admin,super_admin}'), ('arrived_at_pickup', 'in_progress', '{driver,admin,super_admin}'), ('arrived_at_pickup', 'canceled', '{customer,driver,admin,super_admin}'), ('in_progress', 'arrived_at_destination', '{driver,admin,super_admin}'), ('in_progress', 'completed', '{driver,admin,super_admin}'), ('in_progress', 'canceled', '{admin,driver,customer,super_admin}'), ('in_progress', 'disputed', '{customer,driver,admin,super_admin}'), ('arrived_at_destination', 'completed', '{driver,admin,super_admin}'), ('arrived_at_destination', 'canceled', '{admin,super_admin}'), ('arrived_at_destination', 'disputed', '{customer,driver,admin,super_admin}'), ('completed', 'disputed', '{customer,driver,admin,super_admin}'), ('disputed', 'completed', '{admin,super_admin}');
