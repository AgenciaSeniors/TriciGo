-- ============================================================
-- Migration 00351: harden send_gift ("Regalo")
--
-- Three additions over 00343 (behaviour otherwise identical):
--   1. Idempotency / double-submit guard: an identical gift (same
--      sender → recipient → amount) created within the last 10 seconds
--      is treated as a duplicate (double-tap / retry) and the original
--      transfer id is returned — no second debit. No API change.
--   2. Audit admin-on-behalf gifts: when an admin sends from another
--      user's wallet, record it in admin_actions (it previously left no
--      admin attribution — the ledger row was attributed to the user).
--   3. Reject gifts to a FROZEN recipient wallet (fraud-flagged), and
--      reject unauthenticated callers explicitly (a NULL auth.uid() must
--      never slip through the three-valued-logic caller gate).
-- ============================================================

CREATE OR REPLACE FUNCTION public.send_gift(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount integer,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_from_type wallet_account_type;
  v_to_type   wallet_account_type;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_from_balance INTEGER;
  v_to_balance   INTEGER;
  v_from_frozen  BOOLEAN;
  v_to_frozen    BOOLEAN;
  v_to_active    BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
  v_dup UUID;
BEGIN
  -- Caller gate. Reject NULL auth.uid() explicitly so an unauthenticated
  -- / service-role context can't bypass the gate via three-valued logic.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only gift from your own wallet';
  END IF;

  -- Audit admin-on-behalf gifts (admin sending from another user's wallet).
  IF auth.uid() <> p_from_user_id THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (auth.uid(), 'send_gift_on_behalf', 'user', p_from_user_id::TEXT, COALESCE(p_note, 'Regalo'));
  END IF;

  -- Basic validations (no amount/daily caps by product decision).
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Gift amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot gift to yourself'; END IF;

  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  -- Double-submit guard: identical gift within 10s → return the original.
  SELECT id INTO v_dup
  FROM wallet_transfers
  WHERE from_user_id = p_from_user_id
    AND to_user_id = p_to_user_id
    AND amount = p_amount
    AND kind = 'gift'
    AND reversal_of IS NULL
    AND created_at > NOW() - INTERVAL '10 seconds'
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN v_dup;
  END IF;

  v_from_type := _gift_wallet_type(p_from_user_id);
  v_to_type   := _gift_wallet_type(p_to_user_id);

  PERFORM ensure_wallet_account(p_from_user_id, v_from_type);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  SELECT id, balance, is_frozen INTO v_from_account_id, v_from_balance, v_from_frozen
    FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = v_from_type FOR UPDATE;
  IF COALESCE(v_from_frozen, false) THEN
    RAISE EXCEPTION 'Your wallet is frozen';
  END IF;
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;

  SELECT id, balance, is_frozen INTO v_to_account_id, v_to_balance, v_to_frozen
    FROM wallet_accounts
    WHERE user_id = p_to_user_id AND account_type = v_to_type FOR UPDATE;
  -- Don't push value into a fraud-frozen recipient wallet.
  IF COALESCE(v_to_frozen, false) THEN
    RAISE EXCEPTION 'Recipient wallet is frozen';
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, description, metadata, created_by
  )
  VALUES (
    'gift:' || gen_random_uuid()::TEXT, 'transfer_out', 'posted', 'wallet_transfer',
    COALESCE(p_note, 'Regalo'), jsonb_build_object('kind', 'gift'), p_from_user_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);
  UPDATE wallet_accounts SET balance = v_from_balance - p_amount, updated_at = NOW()
    WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);
  UPDATE wallet_accounts SET balance = v_to_balance + p_amount, updated_at = NOW()
    WHERE id = v_to_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$;
