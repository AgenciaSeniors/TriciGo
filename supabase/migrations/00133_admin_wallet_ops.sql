-- ============================================================
-- TriciGo — Admin wallet ops (manual TriciCoin grant + refund + grace trips)
--
-- Adds RPCs for admin-driven wallet adjustments:
-- 1. admin_adjust_wallet — manual +/- to any user's customer_cash or
--    driver_cash account, with required reason. Creates a ledger_transactions
--    row (type='adjustment'), an entry, and updates wallet_accounts.balance.
-- 2. admin_refund_ride_commission — reverses a ride's commission debit by
--    crediting the driver_cash wallet with the same amount (for dispute
--    resolution, bad fare calcs, etc.).
-- 3. admin_grant_grace_trips — increments a driver's "grace trips" counter
--    (rides where commission is waived). Uses the existing migration 00094
--    columns if present, else a no-op.
--
-- Also ensures driver_profiles has grace_trips_remaining + quota_blocked
-- columns (idempotent via IF NOT EXISTS).
-- ============================================================

-- ─── 1. Columns (idempotent — already exist if 00094 was applied) ───
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS grace_trips_remaining INTEGER DEFAULT 0;

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS quota_blocked BOOLEAN DEFAULT false;

-- ─── 2. RPC: admin_adjust_wallet ───
-- Credits or debits a user's wallet (customer_cash or driver_cash).
-- SECURITY DEFINER: bypasses RLS so admin can touch any user's balance.
-- Returns JSONB with new balance + transaction id.
CREATE OR REPLACE FUNCTION admin_adjust_wallet(
  p_target_user_id UUID,
  p_account_type wallet_account_type,
  p_amount_cup INTEGER,        -- Positive = credit, negative = debit
  p_reason TEXT,
  p_admin_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_account_id UUID;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_is_admin BOOLEAN;
BEGIN
  -- Validate admin role
  SELECT (role = 'admin') INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  -- Validate inputs
  IF p_amount_cup = 0 THEN
    RAISE EXCEPTION 'Amount cannot be zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Reason is required (min 3 chars)';
  END IF;
  IF p_account_type NOT IN ('customer_cash', 'driver_cash') THEN
    RAISE EXCEPTION 'Unsupported account type for admin adjustment: %', p_account_type;
  END IF;

  -- Upsert wallet account (create if missing)
  SELECT id INTO v_account_id
  FROM wallet_accounts
  WHERE user_id = p_target_user_id AND account_type = p_account_type
  LIMIT 1;

  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_target_user_id, p_account_type, 0, 0, 'CUP', true)
    RETURNING id INTO v_account_id;
  END IF;

  -- Create transaction
  INSERT INTO ledger_transactions (type, status, reference_type, reference_id, description, created_by)
  VALUES ('adjustment', 'completed', 'admin_action', p_admin_user_id, p_reason, p_admin_user_id)
  RETURNING id INTO v_tx_id;

  -- Update balance
  UPDATE wallet_accounts
  SET balance = balance + p_amount_cup,
      updated_at = NOW()
  WHERE id = v_account_id
  RETURNING balance INTO v_new_balance;

  -- Create ledger entry
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount_cup, v_new_balance);

  -- Audit log
  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'adjust_wallet', 'wallet_account', v_account_id::TEXT, p_reason);

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'account_id', v_account_id,
    'amount_cup', p_amount_cup,
    'new_balance', v_new_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_adjust_wallet(UUID, wallet_account_type, INTEGER, TEXT, UUID) TO authenticated;

-- ─── 3. RPC: admin_refund_ride_commission ───
-- Credits driver_cash with the commission amount of a specific ride.
CREATE OR REPLACE FUNCTION admin_refund_ride_commission(
  p_ride_id UUID,
  p_admin_user_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_driver_id UUID;
  v_driver_user_id UUID;
  v_commission_amount INTEGER;
  v_result JSONB;
  v_is_admin BOOLEAN;
BEGIN
  -- Validate admin
  SELECT (role = 'admin') INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  -- Validate reason
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  -- Find the commission entry on this ride
  -- Look for a ledger_transactions row of type='commission' with reference_id=ride
  SELECT r.driver_id, dp.user_id
  INTO v_driver_id, v_driver_user_id
  FROM rides r
  JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;

  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'Ride not found or has no driver';
  END IF;

  SELECT SUM(ABS(le.amount))::INTEGER
  INTO v_commission_amount
  FROM ledger_transactions lt
  JOIN ledger_entries le ON le.transaction_id = lt.id
  JOIN wallet_accounts wa ON wa.id = le.account_id
  WHERE lt.type = 'commission'
    AND lt.reference_id = p_ride_id
    AND wa.user_id = v_driver_user_id
    AND wa.account_type = 'driver_cash'
    AND le.amount < 0; -- The debit side

  IF v_commission_amount IS NULL OR v_commission_amount = 0 THEN
    RAISE EXCEPTION 'No commission to refund on this ride';
  END IF;

  -- Reuse admin_adjust_wallet to apply the refund (credit)
  v_result := admin_adjust_wallet(
    v_driver_user_id,
    'driver_cash'::wallet_account_type,
    v_commission_amount,
    'Refund ride ' || p_ride_id::TEXT || ': ' || p_reason,
    p_admin_user_id
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_refund_ride_commission(UUID, UUID, TEXT) TO authenticated;

-- ─── 4. RPC: admin_grant_grace_trips ───
CREATE OR REPLACE FUNCTION admin_grant_grace_trips(
  p_driver_user_id UUID,
  p_trips INTEGER,
  p_admin_user_id UUID,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_total INTEGER;
  v_is_admin BOOLEAN;
BEGIN
  SELECT (role = 'admin') INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  IF p_trips = 0 THEN
    RAISE EXCEPTION 'Trips cannot be zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  UPDATE driver_profiles
  SET grace_trips_remaining = GREATEST(COALESCE(grace_trips_remaining, 0) + p_trips, 0)
  WHERE user_id = p_driver_user_id
  RETURNING grace_trips_remaining INTO v_new_total;

  IF v_new_total IS NULL THEN
    RAISE EXCEPTION 'Driver profile not found';
  END IF;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'grant_grace_trips', 'driver_profile', p_driver_user_id::TEXT,
          p_trips::TEXT || ' trips: ' || p_reason);

  RETURN jsonb_build_object(
    'driver_user_id', p_driver_user_id,
    'trips_added', p_trips,
    'new_total', v_new_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_grant_grace_trips(UUID, INTEGER, UUID, TEXT) TO authenticated;

-- NOTE: admin_apply_promo_to_user RPC deferred — current promotion_uses
-- table tracks actual ride usage, not pre-assignments. To support
-- "admin sends a personalized promo to user X", a new user_promo_assignments
-- table is needed. Skipping for now to keep this migration focused on
-- the wallet ops that were explicitly requested.
