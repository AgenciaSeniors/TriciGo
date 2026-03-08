-- ============================================================
-- TriciGo — Initial Database Schema
-- Platform: Supabase (PostgreSQL 15+)
-- Features: PostGIS, double-entry ledger, ride FSM, RLS
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- ENUM TYPES
-- ============================================================
CREATE TYPE user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'completed', 'canceled', 'disputed');
CREATE TYPE payment_method AS ENUM ('tricicoin', 'cash', 'mixed');
CREATE TYPE vehicle_type AS ENUM ('triciclo', 'moto', 'auto');
CREATE TYPE wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue', 'platform_promotions');
CREATE TYPE ledger_entry_type AS ENUM ('recharge', 'ride_payment', 'ride_hold', 'ride_hold_release', 'commission', 'transfer_in', 'transfer_out', 'promo_credit', 'redemption', 'adjustment');
CREATE TYPE ledger_transaction_status AS ENUM ('pending', 'posted', 'archived', 'reversed');
CREATE TYPE incident_type AS ENUM ('sos', 'safety_concern', 'payment_dispute', 'vehicle_issue', 'driver_behavior', 'passenger_behavior');
CREATE TYPE incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');
CREATE TYPE document_type AS ENUM ('national_id', 'drivers_license', 'vehicle_registration', 'selfie', 'vehicle_photo');
CREATE TYPE promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
CREATE TYPE referral_status AS ENUM ('pending', 'rewarded', 'invalidated');
CREATE TYPE redemption_status AS ENUM ('requested', 'approved', 'processed', 'rejected');
CREATE TYPE zone_type AS ENUM ('operational', 'surge', 'restricted');
CREATE TYPE pricing_snapshot_type AS ENUM ('estimate', 'final');

-- ============================================================
-- USERS & PROFILES
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  email TEXT,
  full_name TEXT NOT NULL DEFAULT '',
  role user_role NOT NULL DEFAULT 'customer',
  avatar_url TEXT,
  preferred_language TEXT NOT NULL DEFAULT 'es',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  default_payment_method payment_method NOT NULL DEFAULT 'cash',
  saved_locations JSONB NOT NULL DEFAULT '[]',
  emergency_contact JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DRIVERS & VEHICLES
-- ============================================================
CREATE TABLE driver_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status driver_status NOT NULL DEFAULT 'pending_verification',
  is_online BOOLEAN NOT NULL DEFAULT false,
  current_location GEOGRAPHY(POINT, 4326),
  current_heading NUMERIC,
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  total_rides INTEGER NOT NULL DEFAULT 0,
  total_rides_completed INTEGER NOT NULL DEFAULT 0,
  zone_id UUID,
  approved_at TIMESTAMPTZ,
  suspended_at TIMESTAMPTZ,
  suspended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_driver_profiles_location ON driver_profiles USING GIST(current_location);
CREATE INDEX idx_driver_profiles_online ON driver_profiles(is_online) WHERE is_online = true;

CREATE TABLE driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  document_type document_type NOT NULL,
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_verified BOOLEAN NOT NULL DEFAULT false,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  type vehicle_type NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL,
  color TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 2,
  is_active BOOLEAN NOT NULL DEFAULT true,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SERVICE TYPES, ZONES & PRICING
-- ============================================================
CREATE TABLE service_type_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name_es TEXT NOT NULL,
  name_en TEXT NOT NULL,
  base_fare_cup INTEGER NOT NULL,
  per_km_rate_cup INTEGER NOT NULL,
  per_minute_rate_cup INTEGER NOT NULL,
  min_fare_cup INTEGER NOT NULL,
  max_passengers INTEGER NOT NULL DEFAULT 2,
  icon_name TEXT NOT NULL DEFAULT 'car',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type zone_type NOT NULL DEFAULT 'operational',
  boundary GEOGRAPHY(POLYGON, 4326) NOT NULL,
  surge_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_zones_boundary ON zones USING GIST(boundary);

-- Add FK from driver_profiles to zones (deferred to avoid circular)
ALTER TABLE driver_profiles ADD CONSTRAINT fk_driver_zone FOREIGN KEY (zone_id) REFERENCES zones(id);

CREATE TABLE pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID REFERENCES zones(id),
  service_type TEXT NOT NULL,
  base_fare_cup INTEGER NOT NULL,
  per_km_rate_cup INTEGER NOT NULL,
  per_minute_rate_cup INTEGER NOT NULL,
  min_fare_cup INTEGER NOT NULL,
  surge_threshold NUMERIC,
  max_surge_multiplier NUMERIC(3,2),
  time_window_start TIME,
  time_window_end TIME,
  day_of_week INTEGER[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WALLET & LEDGER (Double-Entry)
-- ============================================================
CREATE TABLE wallet_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_type wallet_account_type NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  held_balance INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TRC',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, account_type)
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  type ledger_entry_type NOT NULL,
  status ledger_transaction_status NOT NULL DEFAULT 'pending',
  reference_type TEXT,
  reference_id UUID,
  description TEXT NOT NULL DEFAULT '',
  metadata JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id UUID NOT NULL REFERENCES wallet_accounts(id),
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id, created_at DESC);
CREATE INDEX idx_ledger_entries_transaction ON ledger_entries(transaction_id);

-- Enforce immutability: no updates or deletes on ledger_entries
CREATE RULE no_update_ledger_entries AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE no_delete_ledger_entries AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;

CREATE TABLE wallet_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id),
  amount INTEGER NOT NULL,
  status redemption_status NOT NULL DEFAULT 'requested',
  transaction_id UUID REFERENCES ledger_transactions(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  processed_by UUID REFERENCES users(id),
  rejection_reason TEXT
);

-- ============================================================
-- RIDES
-- ============================================================
CREATE TABLE rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id),
  driver_id UUID REFERENCES driver_profiles(id),
  service_type TEXT NOT NULL,
  status ride_status NOT NULL DEFAULT 'searching',
  payment_method payment_method NOT NULL DEFAULT 'cash',
  pickup_location GEOGRAPHY(POINT, 4326) NOT NULL,
  pickup_address TEXT NOT NULL,
  dropoff_location GEOGRAPHY(POINT, 4326) NOT NULL,
  dropoff_address TEXT NOT NULL,
  estimated_fare_cup INTEGER NOT NULL DEFAULT 0,
  estimated_distance_m INTEGER NOT NULL DEFAULT 0,
  estimated_duration_s INTEGER NOT NULL DEFAULT 0,
  final_fare_cup INTEGER,
  actual_distance_m INTEGER,
  actual_duration_s INTEGER,
  scheduled_at TIMESTAMPTZ,
  is_scheduled BOOLEAN NOT NULL DEFAULT false,
  accepted_at TIMESTAMPTZ,
  driver_arrived_at TIMESTAMPTZ,
  pickup_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  canceled_by UUID REFERENCES users(id),
  cancellation_reason TEXT,
  share_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rides_customer ON rides(customer_id, status, created_at DESC);
CREATE INDEX idx_rides_driver ON rides(driver_id, status, created_at DESC);
CREATE INDEX idx_rides_searching ON rides USING GIST(pickup_location) WHERE status = 'searching';

-- ============================================================
-- RIDE STATE MACHINE
-- ============================================================
CREATE TABLE valid_transitions (
  from_status ride_status NOT NULL,
  to_status ride_status NOT NULL,
  allowed_roles user_role[] NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('searching',         'accepted',          ARRAY['driver']::user_role[]),
  ('searching',         'canceled',          ARRAY['customer', 'admin']::user_role[]),
  ('accepted',          'driver_en_route',   ARRAY['driver']::user_role[]),
  ('accepted',          'canceled',          ARRAY['customer', 'driver', 'admin']::user_role[]),
  ('driver_en_route',   'arrived_at_pickup', ARRAY['driver']::user_role[]),
  ('driver_en_route',   'canceled',          ARRAY['driver', 'admin']::user_role[]),
  ('arrived_at_pickup', 'in_progress',       ARRAY['driver']::user_role[]),
  ('arrived_at_pickup', 'canceled',          ARRAY['customer', 'driver', 'admin']::user_role[]),
  ('in_progress',       'completed',         ARRAY['driver', 'admin']::user_role[]),
  ('in_progress',       'disputed',          ARRAY['customer', 'driver']::user_role[]),
  ('disputed',          'completed',         ARRAY['admin', 'super_admin']::user_role[]);

CREATE TABLE ride_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  from_status ride_status,
  to_status ride_status NOT NULL,
  actor_id UUID,
  actor_role user_role,
  reason TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ride_transitions_ride ON ride_transitions(ride_id, created_at DESC);

-- FSM enforcement trigger
CREATE OR REPLACE FUNCTION enforce_ride_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  -- Skip validation for service role (NULL uid)
  IF auth.uid() IS NULL THEN
    -- Log the transition
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  -- Get user role
  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Check if transition is valid
  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  -- Log the transition
  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  -- Update timestamp
  NEW.updated_at := NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_enforce_ride_transition
  BEFORE UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_ride_transition();

-- ============================================================
-- RIDE LOCATION EVENTS & PRICING SNAPSHOTS
-- ============================================================
CREATE TABLE ride_location_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id),
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  heading NUMERIC,
  speed NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ride_locations_ride ON ride_location_events(ride_id, recorded_at DESC);

CREATE TABLE ride_pricing_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  snapshot_type pricing_snapshot_type NOT NULL,
  base_fare INTEGER NOT NULL,
  per_km_rate INTEGER NOT NULL,
  per_minute_rate INTEGER NOT NULL,
  distance_m INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  surge_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  subtotal INTEGER NOT NULL,
  commission_rate NUMERIC(4,3) NOT NULL DEFAULT 0.150,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  pricing_rule_id UUID REFERENCES pricing_rules(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- REVIEWS
-- ============================================================
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewee_id UUID NOT NULL REFERENCES users(id),
  rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ride_id, reviewer_id)
);

CREATE INDEX idx_reviews_reviewee ON reviews(reviewee_id, created_at DESC);

-- ============================================================
-- INCIDENTS
-- ============================================================
CREATE TABLE incident_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID REFERENCES rides(id),
  reported_by UUID NOT NULL REFERENCES users(id),
  against_user_id UUID REFERENCES users(id),
  type incident_type NOT NULL,
  severity incident_severity NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  evidence_urls TEXT[] NOT NULL DEFAULT '{}',
  status incident_status NOT NULL DEFAULT 'open',
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PROMOTIONS & REFERRALS
-- ============================================================
CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  type promotion_type NOT NULL,
  discount_percent NUMERIC,
  discount_fixed_cup INTEGER,
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_promotions_code ON promotions(code) WHERE is_active = true;

CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id),
  referee_id UUID NOT NULL UNIQUE REFERENCES users(id),
  code TEXT NOT NULL,
  status referral_status NOT NULL DEFAULT 'pending',
  bonus_amount INTEGER NOT NULL DEFAULT 0,
  transaction_id UUID REFERENCES ledger_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rewarded_at TIMESTAMPTZ
);

-- ============================================================
-- ADMIN & AUDIT
-- ============================================================
CREATE TABLE admin_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  old_values JSONB,
  new_values JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  old_values JSONB,
  new_values JSONB,
  changed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_table ON audit_log(table_name, created_at DESC);

-- Generic audit trigger
CREATE OR REPLACE FUNCTION record_audit()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, operation, old_values, new_values, changed_by)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    TG_OP,
    CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER audit_rides AFTER INSERT OR UPDATE OR DELETE ON rides FOR EACH ROW EXECUTE FUNCTION record_audit();
CREATE TRIGGER audit_wallet_accounts AFTER INSERT OR UPDATE ON wallet_accounts FOR EACH ROW EXECUTE FUNCTION record_audit();
CREATE TRIGGER audit_driver_profiles AFTER INSERT OR UPDATE ON driver_profiles FOR EACH ROW EXECUTE FUNCTION record_audit();

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role AS $$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT current_user_role() IN ('admin', 'super_admin');
$$ LANGUAGE sql STABLE;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_type_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_location_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ride_pricing_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_transitions ENABLE ROW LEVEL SECURITY;

-- Users
CREATE POLICY "users_select_own" ON users FOR SELECT USING (id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "users_update_own" ON users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY "users_insert_own" ON users FOR INSERT WITH CHECK (id = (SELECT auth.uid()));

-- Customer profiles
CREATE POLICY "cp_select" ON customer_profiles FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "cp_insert" ON customer_profiles FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "cp_update" ON customer_profiles FOR UPDATE USING (user_id = (SELECT auth.uid()));

-- Driver profiles
CREATE POLICY "dp_select_own" ON driver_profiles FOR SELECT USING (user_id = (SELECT auth.uid()) OR (status = 'approved' AND is_online = true) OR is_admin());
CREATE POLICY "dp_update_own" ON driver_profiles FOR UPDATE USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "dp_insert" ON driver_profiles FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

-- Driver documents
CREATE POLICY "dd_select" ON driver_documents FOR SELECT USING (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY "dd_insert" ON driver_documents FOR INSERT WITH CHECK (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())));
CREATE POLICY "dd_update" ON driver_documents FOR UPDATE USING (is_admin());

-- Vehicles
CREATE POLICY "v_select" ON vehicles FOR SELECT USING (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_active = true OR is_admin());
CREATE POLICY "v_insert" ON vehicles FOR INSERT WITH CHECK (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())));
CREATE POLICY "v_update" ON vehicles FOR UPDATE USING (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());

-- Public readable configs
CREATE POLICY "stc_select" ON service_type_configs FOR SELECT USING (true);
CREATE POLICY "stc_admin" ON service_type_configs FOR ALL USING (is_admin());
CREATE POLICY "z_select" ON zones FOR SELECT USING (true);
CREATE POLICY "z_admin" ON zones FOR ALL USING (is_admin());
CREATE POLICY "pr_select" ON pricing_rules FOR SELECT USING (is_active = true OR is_admin());
CREATE POLICY "pr_admin" ON pricing_rules FOR ALL USING (is_admin());
CREATE POLICY "vt_select" ON valid_transitions FOR SELECT USING (true);

-- Wallet (read own, admin manages)
CREATE POLICY "wa_select" ON wallet_accounts FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "wa_admin" ON wallet_accounts FOR ALL USING (is_admin());
CREATE POLICY "lt_select" ON ledger_transactions FOR SELECT USING (created_by = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "le_select" ON ledger_entries FOR SELECT USING (account_id IN (SELECT id FROM wallet_accounts WHERE user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY "wr_select" ON wallet_redemptions FOR SELECT USING (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY "wr_insert" ON wallet_redemptions FOR INSERT WITH CHECK (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())));
CREATE POLICY "wr_admin" ON wallet_redemptions FOR UPDATE USING (is_admin());

-- Rides
CREATE POLICY "r_select_customer" ON rides FOR SELECT USING (customer_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "r_select_driver" ON rides FOR SELECT USING (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR status = 'searching');
CREATE POLICY "r_insert" ON rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));
CREATE POLICY "r_update" ON rides FOR UPDATE USING (customer_id = (SELECT auth.uid()) OR driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())) OR is_admin());

-- Ride transitions (read only for participants)
CREATE POLICY "rt_select" ON ride_transitions FOR SELECT USING (ride_id IN (SELECT id FROM rides WHERE customer_id = (SELECT auth.uid())) OR is_admin());

-- Ride locations
CREATE POLICY "rl_insert" ON ride_location_events FOR INSERT WITH CHECK (driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())));
CREATE POLICY "rl_select" ON ride_location_events FOR SELECT USING (ride_id IN (SELECT id FROM rides WHERE customer_id = (SELECT auth.uid()) OR driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid()))) OR is_admin());

-- Pricing snapshots
CREATE POLICY "rps_select" ON ride_pricing_snapshots FOR SELECT USING (ride_id IN (SELECT id FROM rides WHERE customer_id = (SELECT auth.uid()) OR driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid()))) OR is_admin());

-- Reviews
CREATE POLICY "rev_select" ON reviews FOR SELECT USING (is_visible = true OR reviewee_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "rev_insert" ON reviews FOR INSERT WITH CHECK (reviewer_id = (SELECT auth.uid()));
CREATE POLICY "rev_admin" ON reviews FOR UPDATE USING (is_admin());

-- Incidents
CREATE POLICY "ir_select" ON incident_reports FOR SELECT USING (reported_by = (SELECT auth.uid()) OR against_user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "ir_insert" ON incident_reports FOR INSERT WITH CHECK (reported_by = (SELECT auth.uid()));
CREATE POLICY "ir_admin" ON incident_reports FOR ALL USING (is_admin());

-- Promotions
CREATE POLICY "promo_select" ON promotions FOR SELECT USING (is_active = true AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW()));
CREATE POLICY "promo_admin" ON promotions FOR ALL USING (is_admin());

-- Referrals
CREATE POLICY "ref_select" ON referrals FOR SELECT USING (referrer_id = (SELECT auth.uid()) OR referee_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY "ref_insert" ON referrals FOR INSERT WITH CHECK (referee_id = (SELECT auth.uid()));

-- Admin & Audit (admin only)
CREATE POLICY "aa_select" ON admin_actions FOR SELECT USING (is_admin());
CREATE POLICY "aa_insert" ON admin_actions FOR INSERT WITH CHECK (is_admin() AND admin_id = (SELECT auth.uid()));
CREATE POLICY "al_select" ON audit_log FOR SELECT USING (is_admin());

-- ============================================================
-- REALTIME
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE rides;
ALTER PUBLICATION supabase_realtime ADD TABLE driver_profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE wallet_accounts;

-- ============================================================
-- AUTO-CREATE USER PROFILE ON SIGNUP
-- ============================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, phone, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.phone, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'customer'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();
