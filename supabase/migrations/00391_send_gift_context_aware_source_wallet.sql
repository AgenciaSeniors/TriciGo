-- 00391: gift source wallet is context-aware (caller passes which wallet to debit)
--
-- Bug: `send_gift` resolved the SENDER wallet purely from `users.role` via
-- `_gift_wallet_type` (role='driver' → tricicoin, else customer_cash). A
-- multi-role account (e.g. a super_admin who is also a driver) tapping
-- "Regalar" in the DRIVER wallet expected the debit from tricicoin, but the
-- ELSE branch debited customer_cash → the driver wallet (the one on screen)
-- looked untouched. The money DID move (customer_cash debited, recipient
-- credited) — it just came from the wrong wallet for that user.
--
-- Fix: let the caller (the app, which knows which wallet screen "Regalar" was
-- tapped from) pass the source wallet. The driver app sends 'tricicoin', the
-- client/web apps send 'customer_cash'. Falls back to the role-based helper
-- when not provided, so existing 4-arg callers keep working unchanged.
--
-- Recipient wallet stays role-based (the recipient has no app context at send
-- time; they receive into their spendable role wallet).
--
-- Adding a param changes the arity, so DROP the old 4-arg signature first
-- (a same-name 5-arg-with-default overload would make 4-arg calls ambiguous).

DROP FUNCTION IF EXISTS public.send_gift(uuid, uuid, integer, text);

CREATE OR REPLACE FUNCTION public.send_gift(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount integer,
  p_note text DEFAULT NULL,
  p_from_wallet wallet_account_type DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only gift from your own wallet';
  END IF;

  IF auth.uid() <> p_from_user_id THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (auth.uid(), 'send_gift_on_behalf', 'user', p_from_user_id::TEXT, COALESCE(p_note, 'Regalo'));
  END IF;

  IF p_amount <= 0 THEN RAISE EXCEPTION 'Gift amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot gift to yourself'; END IF;

  -- Only the two spendable gift wallets may be chosen as the source — never a
  -- platform/corporate wallet (the gate already restricts WHO can call this).
  IF p_from_wallet IS NOT NULL
     AND p_from_wallet NOT IN ('customer_cash'::wallet_account_type, 'tricicoin'::wallet_account_type) THEN
    RAISE EXCEPTION 'Invalid gift source wallet: %', p_from_wallet;
  END IF;

  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

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

  -- Source wallet: caller-provided (app context) wins; otherwise role-based.
  v_from_type := COALESCE(p_from_wallet, _gift_wallet_type(p_from_user_id));
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
$function$;

GRANT EXECUTE ON FUNCTION public.send_gift(uuid, uuid, integer, text, wallet_account_type) TO authenticated, service_role;
-- CREATE re-grants EXECUTE to PUBLIC by default; revoke to match the original
-- least-privilege ACL (the function already self-gates on auth.uid()).
REVOKE EXECUTE ON FUNCTION public.send_gift(uuid, uuid, integer, text, wallet_account_type) FROM PUBLIC;
