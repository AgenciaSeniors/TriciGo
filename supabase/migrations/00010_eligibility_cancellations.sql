-- ============================================================
-- Migration 00010: Driver Financial Eligibility + Cancellation Penalties
-- Sprint 12
-- ============================================================

-- Driver eligibility fields
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS is_financially_eligible BOOLEAN DEFAULT true;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS negative_balance_since TIMESTAMPTZ;

-- User cancellation tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS cancellation_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_cancellation_at TIMESTAMPTZ;

-- Cancellation penalties table
CREATE TABLE IF NOT EXISTS cancellation_penalties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID REFERENCES rides(id),
  amount INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS for cancellation_penalties
ALTER TABLE cancellation_penalties ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own penalties"
  ON cancellation_penalties FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Admins can read all penalties"
  ON cancellation_penalties FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('admin', 'super_admin')
    )
  );

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_cancellation_penalties_user_id ON cancellation_penalties(user_id);
CREATE INDEX IF NOT EXISTS idx_cancellation_penalties_created_at ON cancellation_penalties(created_at);

-- ============================================================
-- check_driver_eligibility: blocks driver if negative balance >24h
-- ============================================================
CREATE OR REPLACE FUNCTION check_driver_eligibility(p_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_balance INTEGER;
  v_neg_since TIMESTAMPTZ;
  v_eligible BOOLEAN;
BEGIN
  -- Get user_id from driver profile
  SELECT user_id INTO v_user_id
  FROM driver_profiles WHERE id = p_driver_id;

  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Get driver wallet balance
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM wallet_accounts
  WHERE user_id = v_user_id AND account_type = 'driver_cash';

  -- Get current negative_balance_since
  SELECT negative_balance_since INTO v_neg_since
  FROM driver_profiles WHERE id = p_driver_id;

  IF v_balance < -5000 THEN
    -- Balance is below -50 CUP threshold
    IF v_neg_since IS NULL THEN
      -- Start tracking negative balance
      UPDATE driver_profiles
      SET negative_balance_since = NOW()
      WHERE id = p_driver_id;
      v_eligible := true; -- Not yet 24h
    ELSIF v_neg_since < NOW() - INTERVAL '24 hours' THEN
      -- Over 24h with negative balance → block
      UPDATE driver_profiles
      SET is_financially_eligible = false
      WHERE id = p_driver_id;
      v_eligible := false;
    ELSE
      v_eligible := true; -- Under 24h
    END IF;
  ELSE
    -- Balance OK, reset tracking
    UPDATE driver_profiles
    SET negative_balance_since = NULL,
        is_financially_eligible = true
    WHERE id = p_driver_id;
    v_eligible := true;
  END IF;

  RETURN v_eligible;
END;
$$;

-- ============================================================
-- apply_cancellation_penalty: progressive penalty system
-- 1st cancel/day: free, 2nd: 100 CUP, 3rd+: 200 CUP, 5+/24h: block
-- ============================================================
CREATE OR REPLACE FUNCTION apply_cancellation_penalty(
  p_user_id UUID,
  p_ride_id UUID
)
RETURNS TABLE(penalty_amount INTEGER, is_blocked BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_cancel_count_24h INTEGER;
  v_penalty INTEGER := 0;
  v_blocked BOOLEAN := false;
  v_account_id UUID;
BEGIN
  -- Count cancellations in last 24 hours
  SELECT COUNT(*) INTO v_cancel_count_24h
  FROM cancellation_penalties
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '24 hours';

  -- Progressive penalty
  IF v_cancel_count_24h >= 4 THEN
    -- 5th+ cancellation in 24h → block + 200 CUP
    v_penalty := 20000; -- 200 CUP in centavos
    v_blocked := true;
  ELSIF v_cancel_count_24h >= 2 THEN
    -- 3rd-4th → 200 CUP
    v_penalty := 20000;
  ELSIF v_cancel_count_24h >= 1 THEN
    -- 2nd → 100 CUP
    v_penalty := 10000;
  ELSE
    -- 1st → free
    v_penalty := 0;
  END IF;

  -- Record penalty (even if 0, for tracking)
  INSERT INTO cancellation_penalties (user_id, ride_id, amount, reason)
  VALUES (
    p_user_id,
    p_ride_id,
    v_penalty,
    CASE
      WHEN v_penalty = 0 THEN 'Primera cancelación del día - sin penalización'
      WHEN v_blocked THEN 'Cancelación excesiva - penalización + bloqueo temporal'
      ELSE 'Penalización por cancelación múltiple'
    END
  );

  -- Update user cancellation count
  UPDATE users
  SET cancellation_count = cancellation_count + 1,
      last_cancellation_at = NOW()
  WHERE id = p_user_id;

  -- Deduct penalty from wallet if > 0
  IF v_penalty > 0 THEN
    SELECT id INTO v_account_id
    FROM wallet_accounts
    WHERE user_id = p_user_id
      AND account_type = 'customer_cash';

    IF v_account_id IS NOT NULL THEN
      -- Create ledger transaction for penalty
      WITH txn AS (
        INSERT INTO ledger_transactions (
          idempotency_key, type, status, reference_type, reference_id,
          description, created_by
        ) VALUES (
          'cancel_penalty:' || p_ride_id || ':' || p_user_id,
          'adjustment',
          'posted',
          'cancellation_penalty',
          p_ride_id,
          'Penalización por cancelación de viaje',
          p_user_id
        ) RETURNING id
      )
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      SELECT txn.id, v_account_id, -v_penalty,
             (SELECT balance FROM wallet_accounts WHERE id = v_account_id) - v_penalty
      FROM txn;

      -- Update balance
      UPDATE wallet_accounts
      SET balance = balance - v_penalty
      WHERE id = v_account_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_penalty, v_blocked;
END;
$$;

-- ============================================================
-- Modify accept_ride check: verify driver eligibility
-- ============================================================
CREATE OR REPLACE FUNCTION check_accept_ride_eligibility(p_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_eligible BOOLEAN;
BEGIN
  SELECT is_financially_eligible INTO v_eligible
  FROM driver_profiles
  WHERE id = p_driver_id;

  RETURN COALESCE(v_eligible, true);
END;
$$;
