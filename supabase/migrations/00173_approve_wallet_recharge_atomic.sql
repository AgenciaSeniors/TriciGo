-- ============================================================
-- BUG-116: admin_service.approveRechargeRequest ran ~5 non-atomic
-- Supabase calls client-side:
--   1. SELECT wallet_recharge_requests
--   2. RPC ensure_wallet_account
--   3. SELECT wallet_accounts.balance
--   4. INSERT ledger_transactions
--   5. INSERT ledger_entries
--   6. UPDATE wallet_accounts.balance
--   7. UPDATE wallet_recharge_requests.status
--
-- A client crash / network glitch between steps 5 and 6 left the
-- ledger credited but the wallet balance un-updated, violating the
-- invariant wallet_accounts.balance = SUM(ledger_entries.amount).
-- Retry was blocked by the UNIQUE idempotency_key so the user's
-- money would be stranded in "ledger credited but balance untouched"
-- until manual reconciliation.
--
-- Fix: single RPC that does the entire approval in one transaction.
-- Callable from the admin service layer (admin.service.ts
-- processRecharge). Idempotent via ledger_transactions.idempotency_key.
-- ============================================================

CREATE OR REPLACE FUNCTION public.approve_wallet_recharge(
  p_request_id UUID,
  p_admin_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_req RECORD;
  v_account_id UUID;
  v_current_balance INTEGER;
  v_txn_id UUID;
  v_idempotency_key TEXT;
BEGIN
  SELECT * INTO v_req
  FROM wallet_recharge_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'Recharge request not found: %', p_request_id;
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Recharge request % is not pending (status: %)', p_request_id, v_req.status;
  END IF;

  IF v_req.amount <= 0 THEN
    RAISE EXCEPTION 'Recharge amount must be positive, got %', v_req.amount;
  END IF;

  v_idempotency_key := 'recharge:' || p_request_id::TEXT;

  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE wallet_recharge_requests
    SET status = 'approved',
        processed_by = p_admin_id,
        processed_at = COALESCE(processed_at, NOW())
    WHERE id = p_request_id;
    RETURN v_txn_id;
  END IF;

  v_account_id := ensure_wallet_account(v_req.user_id, 'customer_cash');

  SELECT balance INTO v_current_balance
  FROM wallet_accounts
  WHERE id = v_account_id
  FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES (v_idempotency_key, 'recharge', 'posted', 'recharge_request', p_request_id,
          'Recarga wallet #' || LEFT(p_request_id::TEXT, 8), p_admin_id)
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_req.amount, v_current_balance + v_req.amount);

  UPDATE wallet_accounts
  SET balance = v_current_balance + v_req.amount, updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE wallet_recharge_requests
  SET status = 'approved',
      processed_by = p_admin_id,
      processed_at = NOW()
  WHERE id = p_request_id;

  RETURN v_txn_id;
END;
$$;

COMMENT ON FUNCTION public.approve_wallet_recharge(UUID, UUID) IS
  'BUG-116: atomic approval of wallet recharge. Replaces the 5-call non-atomic flow in admin.service.ts processRecharge. Idempotent via ledger_transactions.idempotency_key.';
