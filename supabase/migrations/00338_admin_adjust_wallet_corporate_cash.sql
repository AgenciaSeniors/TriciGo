-- ============================================================
-- Migration 00338: admin_adjust_wallet — support corporate_cash
--                  (Gap 10 close, last item from corporate audit)
--
-- Context: pre-this-migration, `admin_adjust_wallet` had a hard CHECK
-- that only allowed `customer_cash` and `driver_cash`. Admins (even
-- super_admin) could NOT credit/debit a `corporate_cash` wallet via
-- the official RPC. The workaround was direct SQL ledger inserts
-- (used once during PR-CORP-1 smoke test setup, 2026-05-27).
--
-- This migration extends the CHECK to include `corporate_cash`, so
-- admins can credit/debit corp wallets through the same audited path
-- as customer/driver wallets:
--   * single ledger_transactions row (type='adjustment', posted)
--   * ledger_entries entry with balance_after
--   * admin_actions row for audit trail
--
-- Use case: refunds, corrections, drift cleanup, manual top-ups
-- when a NETOPIA recharge is impossible (e.g., cash payment from
-- the empresa received off-platform).
--
-- Schema note: `wallet_accounts.user_id` for corporate_cash points
-- to the corp creator (the user_id who created the corporate
-- account). The function looks up the wallet via (user_id,
-- account_type) — no change needed there.
--
-- Idempotent: CREATE OR REPLACE on the SAME signature.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(
  p_target_user_id uuid,
  p_account_type wallet_account_type,
  p_amount_cup integer,
  p_reason text,
  p_admin_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_account_id UUID;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;
  IF p_amount_cup = 0 THEN
    RAISE EXCEPTION 'Amount cannot be zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Reason is required (min 3 chars)';
  END IF;

  -- 00338: corporate_cash now allowed. Mirrors the customer/driver
  -- path — single ledger_transactions + ledger_entries + admin_actions.
  IF p_account_type NOT IN ('customer_cash', 'driver_cash', 'corporate_cash') THEN
    RAISE EXCEPTION 'Unsupported account type: %', p_account_type;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
    WHERE user_id = p_target_user_id AND account_type = p_account_type LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_target_user_id, p_account_type, 0, 0, 'CUP', true)
    RETURNING id INTO v_account_id;
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, created_by
  )
  VALUES (
    'admin_adjust:' || gen_random_uuid()::TEXT,
    'adjustment', 'posted', 'admin_action',
    p_admin_user_id, p_reason, p_admin_user_id
  )
  RETURNING id INTO v_tx_id;

  UPDATE wallet_accounts SET balance = balance + p_amount_cup, updated_at = NOW()
  WHERE id = v_account_id RETURNING balance INTO v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount_cup, v_new_balance);

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'adjust_wallet', 'wallet_account', v_account_id::TEXT, p_reason);

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'account_id', v_account_id,
    'amount_cup', p_amount_cup,
    'new_balance', v_new_balance
  );
END;
$function$;

COMMENT ON FUNCTION public.admin_adjust_wallet(uuid, wallet_account_type, integer, text, uuid) IS
  '00338: closes Gap 10 of corporate audit. Now accepts customer_cash, driver_cash, AND corporate_cash. Same ledger pattern across all three account types.';
