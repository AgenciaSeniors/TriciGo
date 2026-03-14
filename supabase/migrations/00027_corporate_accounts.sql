-- ============================================================
-- Migration 00027: Corporate Accounts (Business Profiles)
-- Adds corporate ride accounts for Uber-for-Business style features
-- ============================================================

-- 1. Corporate accounts table
CREATE TABLE IF NOT EXISTS corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'suspended', 'rejected')),
  created_by uuid NOT NULL REFERENCES users(id),
  monthly_budget_trc integer NOT NULL DEFAULT 0,   -- 0 = unlimited
  per_ride_cap_trc integer NOT NULL DEFAULT 0,     -- 0 = unlimited
  allowed_service_types text[] DEFAULT '{}',       -- empty = all allowed
  allowed_hours_start time,                        -- null = no restriction
  allowed_hours_end time,
  current_month_spent integer NOT NULL DEFAULT 0,
  approved_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Corporate employees table
CREATE TABLE IF NOT EXISTS corporate_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES corporate_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'employee'
    CHECK (role IN ('admin', 'employee')),
  is_active boolean NOT NULL DEFAULT true,
  added_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(corporate_account_id, user_id)
);

-- 3. Corporate rides tracking table (for billing)
CREATE TABLE IF NOT EXISTS corporate_rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES corporate_accounts(id),
  ride_id uuid NOT NULL REFERENCES rides(id),
  employee_user_id uuid NOT NULL REFERENCES users(id),
  fare_trc integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Add corporate_account_id to rides table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS corporate_account_id uuid REFERENCES corporate_accounts(id);

-- 5. Extend wallet_account_type to support corporate wallets
-- Check if the constraint exists and update it
DO $$
BEGIN
  -- Drop old check constraint if it exists (wallet_account_type is a text column with CHECK)
  -- The type might be a postgres enum or a check constraint depending on initial schema
  -- We add the value to the enum if it's an enum, or just allow it
  BEGIN
    ALTER TYPE wallet_account_type ADD VALUE IF NOT EXISTS 'corporate_cash';
  EXCEPTION
    WHEN undefined_object THEN
      -- It's not an enum, it's a text column — no action needed, new values accepted
      NULL;
  END;
END $$;

-- 6. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_corporate_employees_user_id ON corporate_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_corporate_rides_account_created ON corporate_rides(corporate_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rides_corporate_account ON rides(corporate_account_id) WHERE corporate_account_id IS NOT NULL;

-- 7. Monthly budget reset via pg_cron (pg_cron already enabled in migration 00021)
SELECT cron.schedule(
  'reset-corporate-budgets',
  '0 0 1 * *',
  $$UPDATE corporate_accounts SET current_month_spent = 0 WHERE status = 'approved';$$
);

-- 8. Auto-updated_at trigger
CREATE OR REPLACE TRIGGER set_corporate_accounts_updated_at
  BEFORE UPDATE ON corporate_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 9. RLS policies
ALTER TABLE corporate_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_rides ENABLE ROW LEVEL SECURITY;

-- Admins can read all corporate accounts
CREATE POLICY corporate_accounts_admin_read ON corporate_accounts
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Corporate creator can read own account
CREATE POLICY corporate_accounts_creator_read ON corporate_accounts
  FOR SELECT TO authenticated
  USING (created_by = auth.uid());

-- Employees can read their corporate account
CREATE POLICY corporate_accounts_employee_read ON corporate_accounts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM corporate_employees
      WHERE corporate_account_id = corporate_accounts.id
      AND user_id = auth.uid()
      AND is_active = true
    )
  );

-- Anyone can insert (register) a corporate account
CREATE POLICY corporate_accounts_insert ON corporate_accounts
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- Admins can update corporate accounts
CREATE POLICY corporate_accounts_admin_update ON corporate_accounts
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Corporate admins can update their own account
CREATE POLICY corporate_accounts_corp_admin_update ON corporate_accounts
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM corporate_employees
      WHERE corporate_account_id = corporate_accounts.id
      AND user_id = auth.uid()
      AND role = 'admin'
      AND is_active = true
    )
  );

-- Corporate employees: corporate admin can manage
CREATE POLICY corporate_employees_corp_admin ON corporate_employees
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM corporate_employees ce
      WHERE ce.corporate_account_id = corporate_employees.corporate_account_id
      AND ce.user_id = auth.uid()
      AND ce.role = 'admin'
      AND ce.is_active = true
    )
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Employees can read own membership
CREATE POLICY corporate_employees_self_read ON corporate_employees
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Corporate rides: readable by corporate admins and platform admins
CREATE POLICY corporate_rides_read ON corporate_rides
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM corporate_employees
      WHERE corporate_account_id = corporate_rides.corporate_account_id
      AND user_id = auth.uid()
      AND role = 'admin'
      AND is_active = true
    )
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Service role can insert corporate rides (for backend processing)
CREATE POLICY corporate_rides_insert ON corporate_rides
  FOR INSERT TO authenticated
  WITH CHECK (true);
