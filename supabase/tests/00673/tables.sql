-- Tables, enums and constraints as in prod on 2026-11-02 (columns, simple defaults, CHECK and UNIQUE;
-- geography columns as text: no PostGIS here and nothing 00673 does reads them). vehicles is a stub:
-- the driver profile trigger only reads driver_id and is_active.
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TYPE public.incident_severity AS ENUM ('low', 'medium', 'high', 'critical');

CREATE TYPE public.incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');

CREATE TYPE public.incident_type AS ENUM ('sos', 'safety_concern', 'payment_dispute', 'vehicle_issue', 'driver_behavior', 'passenger_behavior', 'review_abuse');

CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');

CREATE TABLE public.admin_actions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id uuid,
  action text,
  target_type text,
  target_id text,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.cancellation_rating_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  ride_id uuid,
  rating_value numeric(3,2),
  role_at_event text,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.cancellation_reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id uuid,
  customer_id uuid,
  signal_type text DEFAULT 'repeated_pair'::text,
  risk_score numeric DEFAULT 0,
  signals jsonb DEFAULT '{}'::jsonb,
  ride_ids uuid[] DEFAULT '{}'::uuid[],
  status text DEFAULT 'pending'::text,
  verdict text,
  sanction_type text,
  admin_notes text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.driver_profiles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  status driver_status DEFAULT 'pending_verification'::driver_status,
  is_online boolean DEFAULT false,
  current_location text,
  current_heading numeric,
  rating_avg numeric(3,2) DEFAULT 5.00,
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
  match_score numeric DEFAULT 50.0,
  acceptance_rate numeric DEFAULT 100.0,
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
  preferences jsonb DEFAULT '{}'::jsonb,
  terms_accepted_at timestamp with time zone,
  auto_offline_at timestamp with time zone
);

CREATE TABLE public.fraud_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  alert_type text,
  severity text DEFAULT 'medium'::text,
  details jsonb,
  resolved boolean DEFAULT false,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  resolution_note text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.incident_reports (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  reported_by uuid,
  against_user_id uuid,
  type incident_type,
  severity incident_severity DEFAULT 'medium'::incident_severity,
  description text,
  evidence_urls text[] DEFAULT '{}'::text[],
  status incident_status DEFAULT 'open'::incident_status,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  resolution_notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  review_id uuid
);

CREATE TABLE public.lost_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  reporter_id uuid,
  driver_id uuid,
  description text,
  category text DEFAULT 'other'::text,
  photo_urls text[] DEFAULT '{}'::text[],
  status text DEFAULT 'reported'::text,
  driver_response text,
  driver_found boolean,
  return_fee_cup integer,
  return_location text,
  return_notes text,
  admin_notes text,
  resolved_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  resolved_at timestamp with time zone
);

CREATE TABLE public.notification_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text,
  body text,
  target_type text,
  target_user_id uuid,
  sent_by uuid,
  sent_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.notification_preferences (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  ride_updates boolean DEFAULT true,
  chat_messages boolean DEFAULT true,
  promotions boolean DEFAULT true,
  payment_updates boolean DEFAULT true,
  driver_approval boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  type text,
  title text,
  body text,
  data jsonb,
  read boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.review_tags (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  review_id uuid,
  tag_id uuid,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.reviews (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  reviewer_id uuid,
  reviewee_id uuid,
  rating smallint,
  comment text,
  is_visible boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  is_featured boolean DEFAULT false
);

CREATE TABLE public.ride_disputes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  opened_by uuid,
  reason text,
  description text,
  evidence_urls text[] DEFAULT '{}'::text[],
  status text DEFAULT 'open'::text,
  priority text DEFAULT 'normal'::text,
  respondent_id uuid,
  respondent_message text,
  respondent_evidence_urls text[] DEFAULT '{}'::text[],
  respondent_replied_at timestamp with time zone,
  resolution text,
  resolution_notes text,
  refund_amount_trc integer,
  refund_transaction_id uuid,
  assigned_to uuid,
  admin_notes text,
  sla_first_response_at timestamp with time zone,
  sla_resolution_deadline timestamp with time zone,
  support_ticket_id uuid,
  incident_report_id uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone,
  resolved_at timestamp with time zone,
  ride_estimated_fare_trc integer,
  ride_final_fare_trc integer
);

CREATE TABLE public.ride_transitions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid,
  from_status ride_status,
  to_status ride_status,
  actor_id uuid,
  actor_role user_role,
  reason text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.rides (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid,
  driver_id uuid,
  service_type text,
  status ride_status DEFAULT 'searching'::ride_status,
  payment_method payment_method DEFAULT 'cash'::payment_method,
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
  surge_multiplier numeric DEFAULT 1.0,
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
  ride_mode text DEFAULT 'passenger'::text,
  estimated_duration_hours numeric(4,2),
  payment_status text DEFAULT 'not_applicable'::text,
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
  driver_gps_status driver_gps_status DEFAULT 'healthy'::driver_gps_status,
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

CREATE TABLE public.support_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  ride_id uuid,
  category text,
  subject text,
  description text,
  status text DEFAULT 'open'::text,
  priority text DEFAULT 'normal'::text,
  assigned_to uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone,
  resolved_at timestamp with time zone
);

CREATE TABLE public.ticket_messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_id uuid,
  sender_id uuid,
  message text,
  is_admin boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.user_blocks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  blocker_id uuid,
  blocked_id uuid,
  reason text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  phone text,
  email text,
  full_name text DEFAULT ''::text,
  role user_role DEFAULT 'customer'::user_role,
  avatar_url text,
  preferred_language text DEFAULT 'es'::text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  level user_level DEFAULT 'bronce'::user_level,
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
  from_status ride_status,
  to_status ride_status,
  allowed_roles user_role[]
);

ALTER TABLE public.cancellation_rating_events ADD CONSTRAINT cancellation_rating_events_rating_value_check CHECK (((rating_value IS NULL) OR ((rating_value >= 1.0) AND (rating_value <= 5.0))));

ALTER TABLE public.cancellation_reviews ADD CONSTRAINT cancellation_reviews_sanction_type_check CHECK ((sanction_type = ANY (ARRAY['warning'::text, 'reputation'::text])));

ALTER TABLE public.cancellation_reviews ADD CONSTRAINT cancellation_reviews_signal_type_check CHECK ((signal_type = ANY (ARRAY['repeated_pair'::text, 'driver_rate_anomaly'::text, 'reported'::text])));

ALTER TABLE public.cancellation_reviews ADD CONSTRAINT cancellation_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'dismissed'::text, 'sanctioned'::text])));

ALTER TABLE public.cancellation_reviews ADD CONSTRAINT cancellation_reviews_verdict_check CHECK ((verdict = ANY (ARRAY['just'::text, 'unjust'::text])));

ALTER TABLE public.driver_profiles ADD CONSTRAINT driver_profiles_user_id_key UNIQUE (user_id);

ALTER TABLE public.lost_items ADD CONSTRAINT chk_lost_item_category CHECK ((category = ANY (ARRAY['phone'::text, 'wallet'::text, 'bag'::text, 'clothing'::text, 'electronics'::text, 'documents'::text, 'keys'::text, 'other'::text])));

ALTER TABLE public.lost_items ADD CONSTRAINT chk_lost_item_status CHECK ((status = ANY (ARRAY['reported'::text, 'driver_notified'::text, 'found'::text, 'not_found'::text, 'return_arranged'::text, 'returned'::text, 'closed'::text])));

ALTER TABLE public.lost_items ADD CONSTRAINT lost_items_return_fee_nonneg CHECK (((return_fee_cup IS NULL) OR (return_fee_cup >= 0)));

ALTER TABLE public.notification_log ADD CONSTRAINT notification_log_target_type_check CHECK ((target_type = ANY (ARRAY['all'::text, 'customers'::text, 'drivers'::text, 'user'::text])));

ALTER TABLE public.notification_preferences ADD CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id);

ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['ride'::text, 'ride_offer'::text, 'ride_matching'::text, 'chat'::text, 'proximity'::text, 'payment'::text, 'wallet_recharge'::text, 'wallet_recharge_refund'::text, 'wallet_credit'::text, 'wallet_debit'::text, 'scheduled_ride'::text, 'lost_item'::text, 'dispute_update'::text, 'sos'::text, 'delivery'::text, 'system'::text, 'promo'::text, 'announcement'::text, 'blog'::text, 'news'::text, 'campaign'::text, 'ride_updates'::text, 'wallet_v2_migration'::text, 'partner_coupon'::text])));

ALTER TABLE public.review_tags ADD CONSTRAINT review_tags_review_id_tag_id_key UNIQUE (review_id, tag_id);

ALTER TABLE public.reviews ADD CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));

ALTER TABLE public.ride_disputes ADD CONSTRAINT chk_dispute_priority_valid CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));

ALTER TABLE public.ride_disputes ADD CONSTRAINT chk_dispute_status_valid CHECK ((status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved_rider'::text, 'resolved_driver'::text, 'escalated'::text, 'closed'::text])));

ALTER TABLE public.ride_disputes ADD CONSTRAINT chk_estimated_fare_non_negative CHECK (((ride_estimated_fare_trc IS NULL) OR (ride_estimated_fare_trc >= 0)));

ALTER TABLE public.ride_disputes ADD CONSTRAINT chk_final_fare_non_negative CHECK (((ride_final_fare_trc IS NULL) OR (ride_final_fare_trc >= 0)));

ALTER TABLE public.ride_disputes ADD CONSTRAINT one_dispute_per_ride UNIQUE (ride_id);

ALTER TABLE public.ride_disputes ADD CONSTRAINT ride_disputes_refund_nonneg CHECK (((refund_amount_trc IS NULL) OR (refund_amount_trc >= 0)));

ALTER TABLE public.rides ADD CONSTRAINT chk_payment_status_valid CHECK ((payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'captured'::text, 'completed'::text, 'failed'::text, 'refunded'::text, 'partially_refunded'::text, 'not_applicable'::text])));

ALTER TABLE public.rides ADD CONSTRAINT rides_cancellation_fee_cup_nonneg CHECK (((cancellation_fee_cup IS NULL) OR (cancellation_fee_cup >= (0)::numeric)));

ALTER TABLE public.rides ADD CONSTRAINT rides_cancellation_fee_trc_nonneg CHECK (((cancellation_fee_trc IS NULL) OR (cancellation_fee_trc >= (0)::numeric)));

ALTER TABLE public.rides ADD CONSTRAINT rides_cancellation_reason_code_chk CHECK (((cancellation_reason_code IS NULL) OR (cancellation_reason_code = ANY (ARRAY['changed_plans'::text, 'driver_delay'::text, 'wrong_price'::text, 'other'::text, 'no_show'::text, 'passenger_gone'::text, 'breakdown'::text, 'safety'::text, 'emergency'::text]))));

ALTER TABLE public.rides ADD CONSTRAINT rides_cash_amount_nonneg CHECK (((cash_amount_cup IS NULL) OR (cash_amount_cup >= 0)));

ALTER TABLE public.rides ADD CONSTRAINT rides_discount_amount_nonneg CHECK (((discount_amount_cup IS NULL) OR (discount_amount_cup >= 0)));

ALTER TABLE public.rides ADD CONSTRAINT rides_dropoff_notes_len CHECK (((dropoff_notes IS NULL) OR (char_length(dropoff_notes) <= 200)));

ALTER TABLE public.rides ADD CONSTRAINT rides_estimated_fare_cup_nonneg CHECK (((estimated_fare_cup IS NULL) OR (estimated_fare_cup >= 0)));

ALTER TABLE public.rides ADD CONSTRAINT rides_estimated_fare_trc_nonneg CHECK (((estimated_fare_trc IS NULL) OR (estimated_fare_trc >= 0)));

ALTER TABLE public.rides ADD CONSTRAINT rides_pickup_notes_len CHECK (((pickup_notes IS NULL) OR (char_length(pickup_notes) <= 200)));

ALTER TABLE public.rides ADD CONSTRAINT rides_wallet_ratio_range CHECK (((wallet_ratio IS NULL) OR ((wallet_ratio >= (0)::numeric) AND (wallet_ratio <= (1)::numeric))));

ALTER TABLE public.user_blocks ADD CONSTRAINT user_blocks_no_self CHECK ((blocker_id <> blocked_id));

ALTER TABLE public.user_blocks ADD CONSTRAINT user_blocks_unique UNIQUE (blocker_id, blocked_id);

ALTER TABLE public.users ADD CONSTRAINT users_marketing_opt_in_source_chk CHECK (((marketing_opt_in_source IS NULL) OR (marketing_opt_in_source = ANY (ARRAY['signup'::text, 'prompt'::text, 'settings'::text]))));

ALTER TABLE public.users ADD CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)));

ALTER TABLE public.valid_transitions ADD CONSTRAINT valid_transitions_pkey PRIMARY KEY (from_status, to_status);

CREATE UNIQUE INDEX uq_cancellation_rating_events_user_ride ON public.cancellation_rating_events USING btree (user_id, ride_id) WHERE (ride_id IS NOT NULL);

CREATE UNIQUE INDEX uq_cancellation_reviews_pending_pair ON public.cancellation_reviews USING btree (driver_id, customer_id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX idx_lost_items_active_per_ride ON public.lost_items USING btree (ride_id) WHERE (status <> ALL (ARRAY['returned'::text, 'closed'::text]));

CREATE UNIQUE INDEX reviews_ride_id_reviewer_id_key ON public.reviews USING btree (ride_id, reviewer_id) WHERE (reviewer_id <> '00000000-0000-0000-0000-000000000099'::uuid);

CREATE UNIQUE INDEX idx_rides_share_token ON public.rides USING btree (share_token) WHERE (share_token IS NOT NULL);

CREATE UNIQUE INDEX rides_one_active_per_customer ON public.rides USING btree (customer_id) WHERE ((status = ANY (ARRAY['searching'::ride_status, 'accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status])) AND (NOT (COALESCE(is_scheduled, false) AND (NOT COALESCE(scheduled_notified, false)))));

CREATE UNIQUE INDEX rides_one_active_per_driver ON public.rides USING btree (driver_id) WHERE ((driver_id IS NOT NULL) AND (status = ANY (ARRAY['accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status])));

CREATE TABLE public.vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid, is_active boolean DEFAULT true);
