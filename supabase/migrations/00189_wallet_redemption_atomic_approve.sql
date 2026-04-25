-- ============================================================
-- BUG-132: admin.service.ts processRedemption only sets status to
-- 'approved'/'rejected' on the wallet_redemptions row. The TODO at
-- line 1283 says "implement full ledger debit when wallet_redemptions
-- table is ready" — but the table IS ready, the implementation
-- never landed. Effect: an approved redemption doesn't decrement
-- the driver's driver_cash wallet. The driver receives the cash
-- payout off-platform, but their wallet balance stays at the
-- pre-redemption value, so they can request the SAME amount again.
-- This is a direct double-pay vulnerability against the platform.
--
-- Also: wallet_redemptions has no CHECK constraint on amount, so a
-- driver could INSERT amount = -5000. Once "approved" by admin, the
-- ledger debit (negative amount) would CREDIT the driver's wallet.
--
-- Fix:
--   1. Add CHECK (amount > 0) so negative requests are rejected at
--      the table layer.
--   2. Create approve_redemption(p_redemption_id, p_admin_id) — a
--      SECURITY DEFINER RPC that:
--        - is_admin() gate on the caller
--        - locks the redemption row + driver_cash account FOR UPDATE
--        - rejects re-approval if status is no longer 'requested'
--        - rejects if driver balance < amount (no negative wallets)
--        - posts a balanced ledger transaction (driver_cash -amount,
--          platform_revenue +amount with description)
--        - flips status to 'approved' with processed_by + processed_at
--        - idempotent via 'redemption_approve:' || redemption_id
--
-- The reject path remains simple — admin just sets status='rejected'
-- via the existing wr_admin policy, no ledger movement needed.
-- ============================================================

-- Step 1: prevent negative redemption requests at the table level
ALTER TABLE public.wallet_redemptions
  ADD CONSTRAINT wallet_redemptions_amount_positive CHECK (amount > 0) NOT VALID;

-- Validate against existing rows. If an existing redemption has
-- amount <= 0 (none expected in production but defensive), the
-- migration will fail loudly so an admin can clean up first.
ALTER TABLE public.wallet_redemptions
  VALIDATE CONSTRAINT wallet_redemptions_amount_positive;

-- Step 2: atomic approval RPC
CREATE OR REPLACE FUNCTION public.approve_redemption(
  p_redemption_id uuid,
  p_admin_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_redemption RECORD;
  v_driver_user_id UUID;
  v_account_id UUID;
  v_balance INTEGER;
  v_platform_account_id UUID;
  v_platform_balance INTEGER;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_idempotency_key TEXT;
  v_existing_txn UUID;
  v_txn_id UUID;
  v_caller_is_admin BOOLEAN;
BEGIN
  -- BUG-132: caller must be admin/super_admin
  SELECT (role IN ('admin','super_admin'))
    INTO v_caller_is_admin
  FROM users WHERE id = auth.uid();
  IF NOT COALESCE(v_caller_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to approve redemptions';
  END IF;

  SELECT * INTO v_redemption
  FROM wallet_redemptions
  WHERE id = p_redemption_id
  FOR UPDATE;

  IF v_redemption IS NULL THEN
    RAISE EXCEPTION 'Redemption not found: %', p_redemption_id;
  END IF;

  IF v_redemption.status <> 'requested' THEN
    RAISE EXCEPTION 'Redemption % is not in requested state (status: %)',
      p_redemption_id, v_redemption.status;
  END IF;

  IF v_redemption.amount <= 0 THEN
    RAISE EXCEPTION 'Redemption amount must be positive, got %', v_redemption.amount;
  END IF;

  -- Idempotency: if a previous run created the ledger txn, reuse it.
  v_idempotency_key := 'redemption_approve:' || p_redemption_id::TEXT;
  SELECT id INTO v_existing_txn
  FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_existing_txn IS NOT NULL THEN
    UPDATE wallet_redemptions
    SET status = 'approved',
        processed_by = p_admin_id,
        processed_at = COALESCE(processed_at, NOW()),
        transaction_id = v_existing_txn
    WHERE id = p_redemption_id;
    RETURN v_existing_txn;
  END IF;

  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = v_redemption.driver_id;
  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'Driver profile not found for redemption %', p_redemption_id;
  END IF;

  v_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

  SELECT balance INTO v_balance FROM wallet_accounts WHERE id = v_account_id FOR UPDATE;
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  IF v_balance < v_redemption.amount THEN
    RAISE EXCEPTION 'Driver balance (%) is less than redemption amount (%)',
      v_balance, v_redemption.amount;
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, created_by
  ) VALUES (
    v_idempotency_key, 'redemption', 'posted',
    'wallet_redemption', p_redemption_id,
    'Cashout approved #' || LEFT(p_redemption_id::TEXT, 8),
    p_admin_id
  ) RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, -v_redemption.amount, v_balance - v_redemption.amount);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, v_redemption.amount, v_platform_balance + v_redemption.amount);

  UPDATE wallet_accounts SET balance = balance - v_redemption.amount, updated_at = NOW()
  WHERE id = v_account_id;
  UPDATE wallet_accounts SET balance = balance + v_redemption.amount, updated_at = NOW()
  WHERE id = v_platform_account_id;

  UPDATE wallet_redemptions
  SET status = 'approved',
      processed_by = p_admin_id,
      processed_at = NOW(),
      transaction_id = v_txn_id
  WHERE id = p_redemption_id;

  RETURN v_txn_id;
END;
$$;

COMMENT ON FUNCTION public.approve_redemption(uuid, uuid) IS
  'BUG-132: atomic redemption approval. Replaces admin.service.ts processRedemption bare-status-update for the approved path. Debits driver_cash, credits platform_revenue, idempotent.';

GRANT EXECUTE ON FUNCTION public.approve_redemption(uuid, uuid) TO authenticated;
