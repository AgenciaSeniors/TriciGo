-- ============================================================
-- Migration 00094: TRC Currency Rebase + Driver Quota System
--
-- BREAKING CHANGE: 1 TRC = 1 CUP (was 1 TRC = 1 USD)
-- - All TRC centavo values are converted to whole CUP/TRC units
-- - New driver_quota wallet account type
-- - New platform config for quota deduction settings
-- - New fields on rides for quota tracking
-- - New fields on driver_profiles for grace period
-- ============================================================

-- ─── 1. REBASE TRC VALUES ─────────────────────────────────────
-- Convert centavos → whole CUP/TRC units using current exchange rate
-- Formula: old_centavos × (exchange_rate / 100)
-- Example: 250 centavos (= $2.50 USD) × 520/100 = 1,300 TRC (= 1,300 CUP)

DO $$
DECLARE
  v_rate NUMERIC;
BEGIN
  -- Get current exchange rate
  SELECT usd_cup_rate INTO v_rate
  FROM exchange_rates
  WHERE is_current = true
  LIMIT 1;

  -- Fallback to 520 if no rate exists
  IF v_rate IS NULL THEN
    v_rate := 520;
  END IF;

  -- Rebase wallet_accounts
  UPDATE wallet_accounts SET
    balance = ROUND(balance * v_rate / 100),
    held_balance = ROUND(held_balance * v_rate / 100);

  -- Temporarily drop the no-update rule so we can rebase ledger_entries
  DROP RULE IF EXISTS no_update_ledger_entries ON ledger_entries;

  -- Rebase ledger_entries
  UPDATE ledger_entries SET
    amount = ROUND(amount * v_rate / 100),
    balance_after = ROUND(balance_after * v_rate / 100);

  -- Recreate the no-update rule
  CREATE RULE no_update_ledger_entries AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;

  -- Rebase ride TRC fields (estimated + final)
  UPDATE rides SET
    estimated_fare_trc = ROUND(estimated_fare_trc * v_rate / 100)
  WHERE estimated_fare_trc IS NOT NULL;

  UPDATE rides SET
    final_fare_trc = ROUND(final_fare_trc * v_rate / 100)
  WHERE final_fare_trc IS NOT NULL;

  -- Rebase cancellation fee TRC
  UPDATE rides SET
    cancellation_fee_trc = ROUND(cancellation_fee_trc * v_rate / 100)
  WHERE cancellation_fee_trc > 0;

  -- Rebase ride_splits amount_trc
  UPDATE ride_splits SET
    amount_trc = ROUND(amount_trc * v_rate / 100)
  WHERE amount_trc IS NOT NULL;

  -- Rebase wallet_recharge_requests
  UPDATE wallet_recharge_requests SET
    amount = ROUND(amount * v_rate / 100);

  -- Rebase wallet_transfers
  UPDATE wallet_transfers SET
    amount = ROUND(amount * v_rate / 100);

  -- Rebase payment_intents amount fields
  UPDATE payment_intents SET
    amount_cup = ROUND(amount_cup * v_rate / 100)
  WHERE amount_cup IS NOT NULL;

  -- Rebase pricing snapshot TRC totals
  UPDATE ride_pricing_snapshots SET
    total_trc = ROUND(total_trc * v_rate / 100)
  WHERE total_trc IS NOT NULL;

  -- Rebase wallet_redemptions
  UPDATE wallet_redemptions SET
    amount = ROUND(amount * v_rate / 100);

  -- Rebase cancellation_fee_previews TRC
  -- (These are ephemeral, may not have data)

  RAISE NOTICE 'TRC rebase complete. Rate used: % CUP/USD', v_rate;
END $$;

-- ─── 2. ADD driver_quota ACCOUNT TYPE ──────────────────────────
-- Add new enum value to wallet_account_type
DO $$
BEGIN
  -- Check if the value already exists before adding
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'driver_quota'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'wallet_account_type')
  ) THEN
    ALTER TYPE wallet_account_type ADD VALUE 'driver_quota';
  END IF;
END $$;

-- ─── 3. ADD LEDGER ENTRY TYPES ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'quota_deduction'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ledger_entry_type')
  ) THEN
    ALTER TYPE ledger_entry_type ADD VALUE 'quota_deduction';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'quota_recharge'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'ledger_entry_type')
  ) THEN
    ALTER TYPE ledger_entry_type ADD VALUE 'quota_recharge';
  END IF;
END $$;

-- ─── 4. ADD RIDE FIELDS FOR QUOTA + USD ────────────────────────
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS estimated_fare_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS final_fare_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS quota_deduction_amount INTEGER DEFAULT 0;

-- Backfill USD for existing rides (using their snapshot exchange rate)
UPDATE rides SET
  estimated_fare_usd = ROUND(estimated_fare_cup::NUMERIC / COALESCE(exchange_rate_usd_cup, 520), 2)
WHERE estimated_fare_usd IS NULL AND estimated_fare_cup > 0;

UPDATE rides SET
  final_fare_usd = ROUND(final_fare_cup::NUMERIC / COALESCE(exchange_rate_usd_cup, 520), 2)
WHERE final_fare_usd IS NULL AND final_fare_cup IS NOT NULL AND final_fare_cup > 0;

-- ─── 5. DRIVER PROFILES: QUOTA TRACKING ────────────────────────
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS grace_trips_remaining INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_blocked BOOLEAN DEFAULT false;

-- ─── 6. PLATFORM CONFIG: QUOTA SETTINGS ────────────────────────
INSERT INTO platform_config (key, value) VALUES
  ('quota_deduction_rate', '0.15'),
  ('quota_warning_threshold_pct', '0.20'),
  ('quota_grace_trips', '3')
ON CONFLICT (key) DO NOTHING;

-- ─── 7. ENSURE driver_quota ACCOUNTS FOR EXISTING DRIVERS ──────
-- Create quota accounts for all drivers that don't have one yet
INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
SELECT
  dp.user_id,
  'driver_quota',
  0,
  0,
  'TRC',
  true
FROM driver_profiles dp
WHERE NOT EXISTS (
  SELECT 1 FROM wallet_accounts wa
  WHERE wa.user_id = dp.user_id AND wa.account_type = 'driver_quota'
);

-- ─── 8. RPC: DEDUCT DRIVER QUOTA ───────────────────────────────
CREATE OR REPLACE FUNCTION deduct_driver_quota(
  p_driver_user_id UUID,
  p_ride_id UUID,
  p_fare_amount INTEGER
) RETURNS JSONB AS $$
DECLARE
  v_quota_account_id UUID;
  v_platform_account_id UUID;
  v_quota_balance INTEGER;
  v_deduction_rate NUMERIC;
  v_deduction_amount INTEGER;
  v_grace_trips INTEGER;
  v_max_grace INTEGER;
  v_tx_id UUID;
  v_new_balance INTEGER;
  v_warning_threshold NUMERIC;
  v_total_recharged INTEGER;
  v_warning_active BOOLEAN;
BEGIN
  -- Get deduction rate from platform config
  SELECT (value::NUMERIC) INTO v_deduction_rate
  FROM platform_config WHERE key = 'quota_deduction_rate';
  v_deduction_rate := COALESCE(v_deduction_rate, 0.15);

  -- Calculate deduction
  v_deduction_amount := ROUND(p_fare_amount * v_deduction_rate);
  IF v_deduction_amount <= 0 THEN
    RETURN jsonb_build_object('deduction', 0, 'balance', 0, 'blocked', false);
  END IF;

  -- Lock quota account
  SELECT id, balance INTO v_quota_account_id, v_quota_balance
  FROM wallet_accounts
  WHERE user_id = p_driver_user_id AND account_type = 'driver_quota'
  FOR UPDATE;

  IF v_quota_account_id IS NULL THEN
    RAISE EXCEPTION 'Driver quota account not found for user %', p_driver_user_id;
  END IF;

  -- Lock platform revenue account
  SELECT id INTO v_platform_account_id
  FROM wallet_accounts
  WHERE account_type = 'platform_revenue'
  FOR UPDATE
  LIMIT 1;

  IF v_platform_account_id IS NULL THEN
    RAISE EXCEPTION 'Platform revenue account not found. Ensure a wallet_accounts row with account_type=platform_revenue exists.';
  END IF;

  -- Create ledger transaction
  v_tx_id := gen_random_uuid();
  INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES (
    v_tx_id,
    'quota_deduct_' || p_ride_id::TEXT,
    'quota_deduction',
    'posted',
    'ride',
    p_ride_id,
    'Quota deduction for ride ' || p_ride_id::TEXT,
    p_driver_user_id
  );

  -- Debit driver quota
  v_new_balance := v_quota_balance - v_deduction_amount;
  UPDATE wallet_accounts SET balance = v_new_balance WHERE id = v_quota_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_quota_account_id, -v_deduction_amount, v_new_balance);

  -- Credit platform revenue
  UPDATE wallet_accounts SET balance = balance + v_deduction_amount WHERE id = v_platform_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_platform_account_id, v_deduction_amount,
    (SELECT balance FROM wallet_accounts WHERE id = v_platform_account_id));

  -- Update ride with deduction
  UPDATE rides SET quota_deduction_amount = v_deduction_amount WHERE id = p_ride_id;

  -- Handle grace period if balance <= 0
  IF v_new_balance <= 0 THEN
    SELECT (value::INTEGER) INTO v_max_grace
    FROM platform_config WHERE key = 'quota_grace_trips';
    v_max_grace := COALESCE(v_max_grace, 3);

    SELECT grace_trips_remaining INTO v_grace_trips
    FROM driver_profiles WHERE user_id = p_driver_user_id;

    IF v_grace_trips IS NULL OR v_grace_trips = 0 THEN
      -- First time hitting 0: initialize grace (current trip counts as first grace trip)
      v_grace_trips := v_max_grace - 1;
      UPDATE driver_profiles
      SET grace_trips_remaining = v_grace_trips,
          quota_blocked = (v_grace_trips <= 0)
      WHERE user_id = p_driver_user_id;
    ELSE
      -- Decrement grace trips
      v_grace_trips := v_grace_trips - 1;
      UPDATE driver_profiles
      SET grace_trips_remaining = v_grace_trips,
          quota_blocked = (v_grace_trips <= 0)
      WHERE user_id = p_driver_user_id;
    END IF;
  END IF;

  -- Check warning threshold
  SELECT (value::NUMERIC) INTO v_warning_threshold
  FROM platform_config WHERE key = 'quota_warning_threshold_pct';
  v_warning_threshold := COALESCE(v_warning_threshold, 0.20);

  -- Calculate total recharged for warning comparison
  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_recharged
  FROM ledger_entries le
  JOIN ledger_transactions lt ON lt.id = le.transaction_id
  WHERE le.account_id = v_quota_account_id
    AND lt.type = 'quota_recharge'
    AND le.amount > 0;

  v_warning_active := v_total_recharged > 0
    AND v_new_balance > 0
    AND (v_new_balance::NUMERIC / v_total_recharged) <= v_warning_threshold;

  RETURN jsonb_build_object(
    'deduction', v_deduction_amount,
    'balance', GREATEST(v_new_balance, 0),
    'balance_raw', v_new_balance,
    'grace_trips_remaining', COALESCE(
      (SELECT grace_trips_remaining FROM driver_profiles WHERE user_id = p_driver_user_id), 0),
    'blocked', COALESCE(
      (SELECT quota_blocked FROM driver_profiles WHERE user_id = p_driver_user_id), false),
    'warning_active', v_warning_active,
    'deduction_rate', v_deduction_rate
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 9. RPC: GET DRIVER QUOTA STATUS ───────────────────────────
CREATE OR REPLACE FUNCTION get_driver_quota_status(p_driver_user_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_balance INTEGER;
  v_total_recharged INTEGER;
  v_grace_trips INTEGER;
  v_blocked BOOLEAN;
  v_deduction_rate NUMERIC;
  v_warning_threshold NUMERIC;
  v_warning_active BOOLEAN;
  v_account_id UUID;
BEGIN
  SELECT id, balance INTO v_account_id, v_balance
  FROM wallet_accounts
  WHERE user_id = p_driver_user_id AND account_type = 'driver_quota';

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'balance', 0, 'total_recharged', 0,
      'warning_active', false, 'grace_trips_remaining', 0,
      'blocked', false, 'deduction_rate', 0.15
    );
  END IF;

  v_balance := COALESCE(v_balance, 0);

  -- Total recharged
  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_recharged
  FROM ledger_entries le
  JOIN ledger_transactions lt ON lt.id = le.transaction_id
  WHERE le.account_id = v_account_id
    AND lt.type = 'quota_recharge'
    AND le.amount > 0;

  -- Driver profile fields
  SELECT grace_trips_remaining, quota_blocked
  INTO v_grace_trips, v_blocked
  FROM driver_profiles WHERE user_id = p_driver_user_id;

  -- Config
  SELECT (value::NUMERIC) INTO v_deduction_rate
  FROM platform_config WHERE key = 'quota_deduction_rate';
  v_deduction_rate := COALESCE(v_deduction_rate, 0.15);

  SELECT (value::NUMERIC) INTO v_warning_threshold
  FROM platform_config WHERE key = 'quota_warning_threshold_pct';
  v_warning_threshold := COALESCE(v_warning_threshold, 0.20);

  v_warning_active := v_total_recharged > 0
    AND v_balance > 0
    AND (v_balance::NUMERIC / v_total_recharged) <= v_warning_threshold;

  RETURN jsonb_build_object(
    'balance', GREATEST(v_balance, 0),
    'total_recharged', v_total_recharged,
    'warning_active', v_warning_active,
    'grace_trips_remaining', COALESCE(v_grace_trips, 0),
    'blocked', COALESCE(v_blocked, false),
    'deduction_rate', v_deduction_rate
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 10. RPC: RECHARGE DRIVER QUOTA ────────────────────────────
CREATE OR REPLACE FUNCTION recharge_driver_quota(
  p_driver_user_id UUID,
  p_amount INTEGER,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_account_id UUID;
  v_old_balance INTEGER;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_idem_key TEXT;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Recharge amount must be positive';
  END IF;

  v_idem_key := COALESCE(p_idempotency_key, 'quota_recharge_' || gen_random_uuid()::TEXT);

  -- Check idempotency
  SELECT id INTO v_tx_id
  FROM ledger_transactions
  WHERE idempotency_key = v_idem_key;

  IF v_tx_id IS NOT NULL THEN
    -- Already processed
    SELECT balance INTO v_new_balance
    FROM wallet_accounts
    WHERE user_id = p_driver_user_id AND account_type = 'driver_quota';
    RETURN jsonb_build_object('balance', v_new_balance, 'already_processed', true);
  END IF;

  -- Lock quota account
  SELECT id, balance INTO v_account_id, v_old_balance
  FROM wallet_accounts
  WHERE user_id = p_driver_user_id AND account_type = 'driver_quota'
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    -- Create quota account if it doesn't exist
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_driver_user_id, 'driver_quota', 0, 0, 'TRC', true)
    RETURNING id, balance INTO v_account_id, v_old_balance;
  END IF;

  v_new_balance := v_old_balance + p_amount;

  -- Create transaction
  v_tx_id := gen_random_uuid();
  INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, description, created_by)
  VALUES (v_tx_id, v_idem_key, 'quota_recharge', 'posted', 'quota', 'Quota recharge', p_driver_user_id);

  -- Credit quota account
  UPDATE wallet_accounts SET balance = v_new_balance WHERE id = v_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount, v_new_balance);

  -- Reset grace period & unblock
  UPDATE driver_profiles
  SET grace_trips_remaining = 0, quota_blocked = false
  WHERE user_id = p_driver_user_id;

  RETURN jsonb_build_object(
    'balance', v_new_balance,
    'recharged', p_amount,
    'already_processed', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 11. UPDATE COMMENT ON TRC SEMANTICS ───────────────────────
COMMENT ON TABLE wallet_accounts IS 'Wallet accounts. Balance in TRC whole units (1 TRC = 1 CUP). USD conversion via exchange_rates.';
COMMENT ON TABLE ledger_entries IS 'Double-entry ledger entries. Amounts in TRC whole units (1 TRC = 1 CUP).';

-- ─── 12. REPLACE cup_to_trc_centavos (POST-REBASE) ────────────
-- Since 1 TRC = 1 CUP now, this function just returns the CUP amount.
-- It's still called by complete_ride_and_pay and referral reward triggers.
CREATE OR REPLACE FUNCTION cup_to_trc_centavos(
  p_cup_pesos NUMERIC,
  p_exchange_rate NUMERIC
)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  -- Post-rebase: 1 TRC = 1 CUP (no centavos). Return CUP as-is.
  RETURN ROUND(p_cup_pesos);
END;
$$;
