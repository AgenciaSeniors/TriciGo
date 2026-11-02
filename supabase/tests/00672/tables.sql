-- Tables, enums and constraints as in prod on 2026-11-02 (columns, simple defaults, CHECK and UNIQUE).
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

CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  contact_phone text,
  contact_email text,
  tax_id text,
  status text DEFAULT 'pending'::text,
  created_by uuid,
  monthly_budget_trc integer DEFAULT 0,
  per_ride_cap_trc integer DEFAULT 0,
  allowed_service_types text[],
  allowed_hours_start time without time zone,
  allowed_hours_end time without time zone,
  current_month_spent integer DEFAULT 0,
  approved_at timestamp with time zone,
  suspended_at timestamp with time zone,
  suspended_reason text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  commission_percent numeric(5,2),
  is_fleet_owner boolean DEFAULT false
);

CREATE TABLE public.corporate_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid,
  user_id uuid,
  role text DEFAULT 'employee'::text,
  is_active boolean DEFAULT true,
  added_by uuid,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  document_type public.document_type,
  storage_path text,
  file_name text,
  uploaded_at timestamp with time zone DEFAULT now(),
  is_verified boolean DEFAULT false,
  verified_by uuid,
  verified_at timestamp with time zone,
  rejection_reason text,
  verification_notes text,
  face_match_score real,
  liveness_passed boolean,
  mime_type text
);

CREATE TABLE public.driver_fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid,
  name text,
  vehicle_count_estimate integer,
  vehicle_types text[],
  operating_zones text[],
  estimated_rides_per_day_per_vehicle integer,
  operating_hours_start time without time zone,
  operating_hours_end time without time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  city text
);

CREATE TABLE public.driver_outreach_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_profile_id uuid,
  admin_id uuid,
  channel text DEFAULT 'whatsapp'::text,
  note text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  status public.driver_status DEFAULT 'pending_verification'::public.driver_status,
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

CREATE TABLE public.fleet_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid,
  driver_id uuid,
  driver_name text,
  driver_phone text,
  driver_email text,
  driver_license_number text,
  driver_id_number text,
  status text DEFAULT 'pending_review'::text,
  license_doc_path text,
  added_at timestamp with time zone DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  rejected_reason text,
  signed_up_at timestamp with time zone
);

CREATE TABLE public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  ride_updates boolean DEFAULT true,
  chat_messages boolean DEFAULT true,
  promotions boolean DEFAULT true,
  payment_updates boolean DEFAULT true,
  driver_approval boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text,
  email text,
  full_name text,
  role public.user_role DEFAULT 'customer'::public.user_role,
  avatar_url text,
  preferred_language text DEFAULT 'es'::text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  level public.user_level DEFAULT 'bronce'::public.user_level,
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

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  type public.vehicle_type,
  make text,
  model text,
  year integer,
  color text,
  plate_number text,
  capacity integer,
  is_active boolean DEFAULT true,
  photo_url text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  max_cargo_length_cm integer,
  max_cargo_width_cm integer,
  max_cargo_height_cm integer,
  accepted_cargo_categories text[],
  accepts_cargo boolean DEFAULT false,
  max_cargo_weight_kg numeric(8,2)
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type public.wallet_account_type,
  balance integer DEFAULT 0,
  held_balance integer DEFAULT 0,
  currency text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_frozen boolean DEFAULT false,
  frozen_reason text,
  frozen_at timestamp with time zone,
  frozen_by uuid,
  balance_usd_cents integer,
  held_balance_usd_cents integer,
  migration_rate numeric(10,2),
  migration_bonus_pct numeric(4,2),
  migrated_at timestamp with time zone,
  anchor_usd_cents numeric,
  unbacked_cup integer DEFAULT 0
);

ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_commission_range CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))) NOT VALID;

ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_monthly_budget_nonneg CHECK ((monthly_budget_trc >= 0));

ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_per_ride_cap_nonneg CHECK ((per_ride_cap_trc >= 0));

ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text])));

ALTER TABLE public.driver_fleets ADD CONSTRAINT driver_fleets_city_length CHECK (((city IS NULL) OR ((char_length(city) >= 1) AND (char_length(city) <= 120))));

ALTER TABLE public.driver_fleets ADD CONSTRAINT driver_fleets_corporate_account_id_key UNIQUE (corporate_account_id);

ALTER TABLE public.driver_outreach_log ADD CONSTRAINT driver_outreach_log_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'llamada'::text, 'sms'::text, 'otro'::text])));

ALTER TABLE public.driver_outreach_log ADD CONSTRAINT driver_outreach_log_note_check CHECK (((note IS NULL) OR (length(note) <= 500)));

ALTER TABLE public.fleet_members ADD CONSTRAINT fleet_members_fleet_id_driver_phone_key UNIQUE (fleet_id, driver_phone);

ALTER TABLE public.fleet_members ADD CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'pending_signup'::text, 'active'::text, 'inactive'::text])));

ALTER TABLE public.wallet_accounts ADD CONSTRAINT chk_anchor_usd_cents_nonneg CHECK (((anchor_usd_cents IS NULL) OR (anchor_usd_cents >= (0)::numeric)));

ALTER TABLE public.wallet_accounts ADD CONSTRAINT chk_unbacked_cup_nonneg CHECK ((unbacked_cup >= 0));

ALTER TABLE public.wallet_accounts ADD CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (((account_type <> 'customer_cash'::public.wallet_account_type) OR (balance >= 0)));

ALTER TABLE public.wallet_accounts ADD CONSTRAINT wallet_accounts_user_id_account_type_key UNIQUE (user_id, account_type);
