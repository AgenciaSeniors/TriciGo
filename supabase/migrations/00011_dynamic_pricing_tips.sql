-- ============================================================
-- Migration 00011: Dynamic Pricing (Surge Zones) + Tips
-- Sprint 13
-- ============================================================

-- Surge zones table
CREATE TABLE IF NOT EXISTS surge_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID REFERENCES zones(id),
  multiplier DECIMAL NOT NULL DEFAULT 1.0 CHECK (multiplier >= 1.0 AND multiplier <= 5.0),
  reason TEXT,
  active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

-- RLS for surge_zones (read: everyone, write: admin)
ALTER TABLE surge_zones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active surges"
  ON surge_zones FOR SELECT
  USING (true);

CREATE POLICY "Admins can manage surges"
  ON surge_zones FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
    )
  );

-- Add surge multiplier to rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS surge_multiplier DECIMAL DEFAULT 1.0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_amount INTEGER DEFAULT 0;

-- Tips table
CREATE TABLE IF NOT EXISTS tips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id),
  from_user_id UUID NOT NULL REFERENCES users(id),
  to_driver_id UUID NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for tips
ALTER TABLE tips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own tips"
  ON tips FOR SELECT
  USING (from_user_id = auth.uid() OR to_driver_id = auth.uid());

CREATE POLICY "Users can create tips"
  ON tips FOR INSERT
  WITH CHECK (from_user_id = auth.uid());

CREATE POLICY "Admins can read all tips"
  ON tips FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
    )
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_surge_zones_zone_id ON surge_zones(zone_id);
CREATE INDEX IF NOT EXISTS idx_surge_zones_active ON surge_zones(active);
CREATE INDEX IF NOT EXISTS idx_tips_ride_id ON tips(ride_id);
CREATE INDEX IF NOT EXISTS idx_tips_to_driver ON tips(to_driver_id);

-- ============================================================
-- calculate_surge: get active surge multiplier for a zone
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_surge(p_zone_id UUID)
RETURNS DECIMAL
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_multiplier DECIMAL := 1.0;
BEGIN
  -- Get the highest active surge for this zone
  SELECT COALESCE(MAX(multiplier), 1.0) INTO v_multiplier
  FROM surge_zones
  WHERE zone_id = p_zone_id
    AND active = true
    AND (starts_at IS NULL OR starts_at <= NOW())
    AND (ends_at IS NULL OR ends_at > NOW());

  RETURN v_multiplier;
END;
$$;

-- ============================================================
-- add_tip: 100% goes to driver, no commission
-- ============================================================
CREATE OR REPLACE FUNCTION add_tip(
  p_ride_id UUID,
  p_from_user_id UUID,
  p_amount INTEGER
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_ride RECORD;
  v_driver_user_id UUID;
  v_from_account_id UUID;
  v_driver_account_id UUID;
  v_tip_id UUID;
  v_txn_id UUID;
BEGIN
  -- Get ride info
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id AND status = 'completed';
  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found or not completed';
  END IF;

  -- Get driver user_id
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = v_ride.driver_id;

  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'Driver not found';
  END IF;

  -- Get customer wallet
  SELECT id INTO v_from_account_id
  FROM wallet_accounts
  WHERE user_id = p_from_user_id AND account_type = 'customer_cash';

  IF v_from_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer wallet not found';
  END IF;

  -- Check balance
  IF (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for tip';
  END IF;

  -- Get or create driver wallet
  SELECT id INTO v_driver_account_id
  FROM wallet_accounts
  WHERE user_id = v_driver_user_id AND account_type = 'driver_cash';

  IF v_driver_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_driver_user_id, 'driver_cash', 0, 0, 'TRC', true)
    RETURNING id INTO v_driver_account_id;
  END IF;

  -- Create tip record
  INSERT INTO tips (ride_id, from_user_id, to_driver_id, amount)
  VALUES (p_ride_id, p_from_user_id, v_driver_user_id, p_amount)
  RETURNING id INTO v_tip_id;

  -- Update ride tip_amount
  UPDATE rides SET tip_amount = COALESCE(tip_amount, 0) + p_amount WHERE id = p_ride_id;

  -- Create ledger transaction
  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, created_by
  ) VALUES (
    'tip:' || v_tip_id,
    'adjustment',
    'posted',
    'tip',
    v_tip_id,
    'Propina viaje #' || LEFT(p_ride_id::TEXT, 8),
    p_from_user_id
  ) RETURNING id INTO v_txn_id;

  -- Debit customer
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (
    v_txn_id,
    v_from_account_id,
    -p_amount,
    (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) - p_amount
  );

  UPDATE wallet_accounts SET balance = balance - p_amount WHERE id = v_from_account_id;

  -- Credit driver (100% — no commission on tips)
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (
    v_txn_id,
    v_driver_account_id,
    p_amount,
    (SELECT balance FROM wallet_accounts WHERE id = v_driver_account_id) + p_amount
  );

  UPDATE wallet_accounts SET balance = balance + p_amount WHERE id = v_driver_account_id;

  RETURN v_tip_id;
END;
$$;
