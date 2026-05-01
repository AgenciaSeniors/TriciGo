-- ============================================================
-- Migration 00235: Corporate variable commission + driver fleets
--
-- Adds two capabilities:
-- 1. Per-account commission_percent on corporate_accounts (lets the
--    platform charge a reduced commission to corporate clients/fleets
--    instead of the global 15% in platform_config). NULL means
--    "use the platform default".
-- 2. driver_fleets + fleet_members tables that turn a corporate_account
--    into a fleet owner. Fleet members are drivers added by the owner;
--    they auto-link to the fleet when they sign up with a matching
--    phone number (handled in app code, not in this migration).
--
-- All additions are backwards compatible — existing corporate_accounts
-- continue working with platform default commission.
-- ============================================================

-- 1. corporate_accounts gets two new columns ------------------------------

ALTER TABLE corporate_accounts
  ADD COLUMN IF NOT EXISTS commission_percent decimal(5, 2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_fleet_owner boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN corporate_accounts.commission_percent IS
  'Platform commission rate this account pays per ride (e.g. 8.50 = 8.5%). '
  'NULL means use platform_config.commission_rate (default 15%).';

COMMENT ON COLUMN corporate_accounts.is_fleet_owner IS
  'When true, this corporate account owns a driver fleet (see driver_fleets). '
  'Used to switch the admin review UI between a client-style request and a '
  'fleet-style request with member drivers + license uploads.';

-- 2. driver_fleets ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS driver_fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  vehicle_count_estimate integer,
  -- Mirrors apps/driver service_type slugs (triciclo_basico, moto_standard, ...)
  vehicle_types text[] DEFAULT '{}',
  operating_zones text[] DEFAULT '{}',
  estimated_rides_per_day_per_vehicle integer,
  operating_hours_start time,
  operating_hours_end time,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(corporate_account_id)
);

COMMENT ON TABLE driver_fleets IS
  'One-to-one extension of corporate_accounts when is_fleet_owner = true. '
  'Holds the operational metadata of the fleet (vehicle counts, zones, hours).';

-- 3. fleet_members ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS fleet_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES driver_fleets(id) ON DELETE CASCADE,

  -- Driver auto-links when they register with a matching phone number.
  -- Until then, driver_id stays NULL and the row is in 'pending_signup'.
  driver_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Owner-supplied identity for the driver before they register.
  driver_name text NOT NULL,
  driver_phone text NOT NULL,
  driver_email text,
  driver_license_number text,
  driver_id_number text,

  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'pending_signup', 'active', 'inactive')),

  -- License document — reuses the driver-docs storage bucket.
  license_doc_path text,

  added_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  rejected_reason text,
  signed_up_at timestamptz,

  -- One driver phone per fleet (no duplicates), but the same phone can
  -- in theory belong to different fleets (defensive — admin should reject).
  UNIQUE(fleet_id, driver_phone)
);

CREATE INDEX IF NOT EXISTS fleet_members_phone_idx ON fleet_members(driver_phone);
CREATE INDEX IF NOT EXISTS fleet_members_driver_id_idx ON fleet_members(driver_id);
CREATE INDEX IF NOT EXISTS fleet_members_status_idx ON fleet_members(status);

COMMENT ON TABLE fleet_members IS
  'Drivers belonging to a fleet. Status flow: '
  'pending_review (admin sees it) -> approved (admin OK) -> '
  'pending_signup (waiting for driver to register with matching phone) -> '
  'active (driver registered, fleet member is live).';

-- 4. RLS -------------------------------------------------------------------

ALTER TABLE driver_fleets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_members ENABLE ROW LEVEL SECURITY;

-- Helper to detect admins (mirrors patterns from earlier migrations).
-- The function is_admin() already exists in the schema (used by admin RLS).

-- driver_fleets: owner sees their fleet, admin sees everything.
DROP POLICY IF EXISTS driver_fleets_owner_select ON driver_fleets;
CREATE POLICY driver_fleets_owner_select ON driver_fleets
  FOR SELECT
  USING (
    is_admin(auth.uid())
    OR corporate_account_id IN (
      SELECT id FROM corporate_accounts WHERE created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_fleets_owner_insert ON driver_fleets;
CREATE POLICY driver_fleets_owner_insert ON driver_fleets
  FOR INSERT
  WITH CHECK (
    corporate_account_id IN (
      SELECT id FROM corporate_accounts WHERE created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_fleets_owner_update ON driver_fleets;
CREATE POLICY driver_fleets_owner_update ON driver_fleets
  FOR UPDATE
  USING (
    is_admin(auth.uid())
    OR corporate_account_id IN (
      SELECT id FROM corporate_accounts WHERE created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS driver_fleets_admin_delete ON driver_fleets;
CREATE POLICY driver_fleets_admin_delete ON driver_fleets
  FOR DELETE
  USING (is_admin(auth.uid()));

-- fleet_members: owner sees their fleet's members, the driver themselves
-- sees their own row (so the driver app can know "you belong to fleet X"),
-- admin sees everything.
DROP POLICY IF EXISTS fleet_members_owner_or_self_select ON fleet_members;
CREATE POLICY fleet_members_owner_or_self_select ON fleet_members
  FOR SELECT
  USING (
    is_admin(auth.uid())
    OR driver_id = auth.uid()
    OR fleet_id IN (
      SELECT df.id FROM driver_fleets df
      JOIN corporate_accounts ca ON ca.id = df.corporate_account_id
      WHERE ca.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS fleet_members_owner_insert ON fleet_members;
CREATE POLICY fleet_members_owner_insert ON fleet_members
  FOR INSERT
  WITH CHECK (
    fleet_id IN (
      SELECT df.id FROM driver_fleets df
      JOIN corporate_accounts ca ON ca.id = df.corporate_account_id
      WHERE ca.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS fleet_members_owner_or_admin_update ON fleet_members;
CREATE POLICY fleet_members_owner_or_admin_update ON fleet_members
  FOR UPDATE
  USING (
    is_admin(auth.uid())
    OR fleet_id IN (
      SELECT df.id FROM driver_fleets df
      JOIN corporate_accounts ca ON ca.id = df.corporate_account_id
      WHERE ca.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS fleet_members_owner_delete ON fleet_members;
CREATE POLICY fleet_members_owner_delete ON fleet_members
  FOR DELETE
  USING (
    is_admin(auth.uid())
    OR fleet_id IN (
      SELECT df.id FROM driver_fleets df
      JOIN corporate_accounts ca ON ca.id = df.corporate_account_id
      WHERE ca.created_by = auth.uid()
    )
  );

-- 5. updated_at trigger for driver_fleets ----------------------------------

CREATE OR REPLACE FUNCTION trg_driver_fleets_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS driver_fleets_updated_at ON driver_fleets;
CREATE TRIGGER driver_fleets_updated_at
  BEFORE UPDATE ON driver_fleets
  FOR EACH ROW EXECUTE FUNCTION trg_driver_fleets_updated_at();

-- 6. Auto-link function: driver signs up -> fleet members updated ----------
--
-- Called from a trigger on users INSERT (when a new driver registers).
-- If the user's phone matches any approved fleet_member, we link them.

CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  -- Only run for users with a phone number and no driver_id yet linked.
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  -- Match any approved fleet_member with the same phone that's still
  -- waiting for the driver to sign up.
  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE driver_phone = NEW.phone
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
  RETURNING id INTO v_member_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_link_fleet_member_on_signup ON users;
CREATE TRIGGER auto_link_fleet_member_on_signup
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();

-- The function is also called manually in app code for users that were
-- already registered before their fleet was approved (UPDATE path).
CREATE OR REPLACE FUNCTION public.relink_fleet_member_for_existing_driver(p_driver_id uuid, p_phone text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE fleet_members
  SET driver_id = p_driver_id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE driver_phone = p_phone
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
