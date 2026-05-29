-- ============================================================
-- Migration 00345: "Regalo" — admin RPCs (manual send + reverse)
--
-- Admin capabilities for the gift feature (per product decision):
--   1. admin_send_gift(...)    — credit a gift to a user (promos,
--      support). One-sided credit, mirroring admin_adjust_wallet's
--      established pattern (00338): single ledger entry + admin_actions
--      audit. Recorded in wallet_transfers with from_user_id = NULL
--      (platform-originated) and kind = 'gift'.
--   2. admin_reverse_gift(...) — reverse a user-to-user gift via a
--      compensating ledger transaction (the ledger is immutable; we
--      never UPDATE/DELETE entries). Marks the original reversed.
--
-- Freezing a wallet reuses the existing freeze_wallet(...) RPC (00013);
-- no new function needed.
--
-- Both RPCs use the two-tier admin gate from 00211/00338:
-- auth.uid() = p_admin_user_id AND the caller actually has admin role.
-- ============================================================

-- 1) admin_send_gift — one-sided promotional gift credit to a user.
CREATE OR REPLACE FUNCTION public.admin_send_gift(
  p_to_user_id uuid,
  p_amount integer,
  p_note text,
  p_admin_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_to_type  wallet_account_type;
  v_to_account_id UUID;
  v_new_balance INTEGER;
  v_to_active BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Gift amount must be positive';
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN
    RAISE EXCEPTION 'Reason/note is required (min 3 chars)';
  END IF;
  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  v_to_type := _gift_wallet_type(p_to_user_id);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'admin_gift:' || gen_random_uuid()::TEXT, 'promo_credit', 'posted', 'admin_action',
    p_admin_user_id, p_note, jsonb_build_object('kind', 'gift', 'admin', true), p_admin_user_id
  )
  RETURNING id INTO v_txn_id;

  UPDATE wallet_accounts SET balance = balance + p_amount, updated_at = NOW()
    WHERE user_id = p_to_user_id AND account_type = v_to_type
  RETURNING id, balance INTO v_to_account_id, v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_new_balance);

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (NULL, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (p_admin_user_id, 'send_gift', 'user', p_to_user_id::TEXT, p_note);

  RETURN v_transfer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_send_gift(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_gift(uuid, integer, text, uuid) TO authenticated;

-- 2) admin_reverse_gift — compensating reversal of a user-to-user gift.
CREATE OR REPLACE FUNCTION public.admin_reverse_gift(
  p_transfer_id uuid,
  p_admin_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_orig RECORD;
  v_recip_type wallet_account_type;   -- original recipient's wallet (debited on reversal)
  v_sender_type wallet_account_type;  -- original sender's wallet (credited on reversal)
  v_recip_account_id UUID;
  v_sender_account_id UUID;
  v_recip_balance INTEGER;
  v_sender_balance INTEGER;
  v_txn_id UUID;
  v_new_transfer_id UUID;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  SELECT * INTO v_orig FROM wallet_transfers WHERE id = p_transfer_id;
  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'Gift not found';
  END IF;
  IF v_orig.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Gift already reversed';
  END IF;
  IF v_orig.from_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot reverse a platform-originated gift; use admin_adjust_wallet instead';
  END IF;

  v_recip_type  := _gift_wallet_type(v_orig.to_user_id);
  v_sender_type := _gift_wallet_type(v_orig.from_user_id);
  PERFORM ensure_wallet_account(v_orig.to_user_id, v_recip_type);
  PERFORM ensure_wallet_account(v_orig.from_user_id, v_sender_type);

  SELECT id, balance INTO v_recip_account_id, v_recip_balance FROM wallet_accounts
    WHERE user_id = v_orig.to_user_id AND account_type = v_recip_type FOR UPDATE;
  -- Only customer_cash is allowed to go negative (00115). For other wallets,
  -- refuse if the recipient already spent the gift.
  IF v_recip_type <> 'customer_cash' AND v_recip_balance < v_orig.amount THEN
    RAISE EXCEPTION 'Cannot reverse: recipient already spent the gift (balance %, gift %)',
      v_recip_balance, v_orig.amount;
  END IF;

  SELECT id, balance INTO v_sender_account_id, v_sender_balance FROM wallet_accounts
    WHERE user_id = v_orig.from_user_id AND account_type = v_sender_type FOR UPDATE;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'gift_reversal:' || p_transfer_id::TEXT, 'adjustment', 'posted', 'wallet_transfer',
    p_transfer_id, 'Reversión de regalo',
    jsonb_build_object('kind', 'gift_reversal', 'reversal_of', p_transfer_id), p_admin_user_id
  )
  RETURNING id INTO v_txn_id;

  -- Debit the original recipient.
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_recip_account_id, -v_orig.amount, v_recip_balance - v_orig.amount);
  UPDATE wallet_accounts SET balance = v_recip_balance - v_orig.amount, updated_at = NOW()
    WHERE id = v_recip_account_id;

  -- Credit the original sender.
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_sender_account_id, v_orig.amount, v_sender_balance + v_orig.amount);
  UPDATE wallet_accounts SET balance = v_sender_balance + v_orig.amount, updated_at = NOW()
    WHERE id = v_sender_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind, reversal_of)
    VALUES (v_orig.to_user_id, v_orig.from_user_id, v_orig.amount,
            'Reversión de regalo', v_txn_id, 'gift_reversal', p_transfer_id)
  RETURNING id INTO v_new_transfer_id;

  UPDATE wallet_transfers SET reversed_at = NOW(), reversed_by = p_admin_user_id
    WHERE id = p_transfer_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (p_admin_user_id, 'reverse_gift', 'wallet_transfer', p_transfer_id::TEXT, 'Reversión de regalo');

  RETURN v_new_transfer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_reverse_gift(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reverse_gift(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_send_gift(uuid, integer, text, uuid) IS
  '00345: admin one-sided promo gift credit to a user (mirrors admin_adjust_wallet pattern). Recorded in wallet_transfers (from_user_id NULL, kind gift) + admin_actions.';
COMMENT ON FUNCTION public.admin_reverse_gift(uuid, uuid) IS
  '00345: reverse a user-to-user gift via compensating ledger txn (immutable ledger). Idempotency key gift_reversal:<transfer_id> guards double-reversal.';
