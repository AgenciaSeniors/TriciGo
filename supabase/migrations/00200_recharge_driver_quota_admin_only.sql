-- ============================================================
-- BUG-157: recharge_driver_quota is SECURITY DEFINER, granted to
-- authenticated, with NO admin or payment-source check. A driver
-- (or any authenticated user) could call:
--
--   supabase.rpc('recharge_driver_quota', {
--     p_driver_user_id: my_user_id,
--     p_amount: 999999,
--   });
--
-- and credit themselves arbitrary driver_quota balance, completely
-- bypassing the Stripe payment flow that should be the only entry
-- point. The function also clears grace_trips_remaining and
-- quota_blocked, so the wallet-floor gate from BUG-086 is defeated
-- in the same call.
--
-- The legitimate paid path is process_stripe_driver_quota_recharge,
-- which credits the wallet inline after Stripe confirms a charge.
-- That function does its own ledger writes — it does NOT route
-- through recharge_driver_quota. So gating recharge_driver_quota
-- to admins won't break the Stripe flow.
--
-- Fix: same pattern as BUG-130/131/136. is_admin() check at the
-- top, with the existing trigger-depth allowance kept in case any
-- internal trigger wires it up later (none today, but cheap to
-- preserve).
-- ============================================================

CREATE OR REPLACE FUNCTION public.recharge_driver_quota(
  p_driver_user_id uuid,
  p_amount integer,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_account_id UUID;
  v_old_balance INTEGER;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_idem_key TEXT;
BEGIN
  -- BUG-157: gate. Only admin or trigger-context callers may credit
  -- driver_quota balances directly. Stripe payments go through
  -- process_stripe_driver_quota_recharge which has its own audit.
  IF pg_trigger_depth() = 0 AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: recharge_driver_quota is admin/internal only';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Recharge amount must be positive';
  END IF;
  v_idem_key := COALESCE(p_idempotency_key, 'quota_recharge_' || gen_random_uuid()::TEXT);

  SELECT id INTO v_tx_id FROM ledger_transactions WHERE idempotency_key = v_idem_key;
  IF v_tx_id IS NOT NULL THEN
    SELECT balance INTO v_new_balance FROM wallet_accounts
    WHERE user_id = p_driver_user_id AND account_type = 'driver_quota';
    RETURN jsonb_build_object('balance', v_new_balance, 'already_processed', true);
  END IF;

  SELECT id, balance INTO v_account_id, v_old_balance
  FROM wallet_accounts
  WHERE user_id = p_driver_user_id AND account_type = 'driver_quota'
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_driver_user_id, 'driver_quota', 0, 0, 'TRC', true)
    RETURNING id, balance INTO v_account_id, v_old_balance;
  END IF;

  v_new_balance := v_old_balance + p_amount;
  v_tx_id := gen_random_uuid();
  INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, description, created_by)
  VALUES (v_tx_id, v_idem_key, 'quota_recharge', 'posted', 'quota', 'Quota recharge', p_driver_user_id);
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount, v_new_balance);
  UPDATE wallet_accounts SET balance = v_new_balance WHERE id = v_account_id;

  UPDATE driver_profiles
  SET grace_trips_remaining = 0, quota_blocked = false
  WHERE user_id = p_driver_user_id AND v_new_balance > 0;

  RETURN jsonb_build_object('balance', v_new_balance, 'already_processed', false);
END;
$$;

COMMENT ON FUNCTION public.recharge_driver_quota(uuid, integer, text) IS
  'BUG-157: gated to is_admin() OR pg_trigger_depth() > 0. Stripe payments don''t go through this function (they use process_stripe_driver_quota_recharge with its own ledger writes), so the gate doesn''t affect the legitimate paid path.';
