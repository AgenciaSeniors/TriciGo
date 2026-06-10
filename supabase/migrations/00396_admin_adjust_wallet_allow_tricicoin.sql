-- ============================================================================
-- 00396 — admin_adjust_wallet: allow 'tricicoin' (ADM-01)
-- ============================================================================
-- BUG (audit 2026-06-10, finding ADM-01): the admin "Ajustar saldo TC" modal
-- sends account_type='tricicoin' for driver top-ups (BUG-276 made that the
-- default precisely because crediting driver_cash was useless — the wallet
-- accept_ride checks is tricicoin), but this RPC's whitelist only accepted
-- customer_cash/driver_cash/corporate_cash → RAISE 'Unsupported account
-- type: tricicoin'. Net effect: there was NO working path for an admin to
-- top up the live driver wallet that gates ride acceptance
-- (driver_can_afford_commission, 00367).
--
-- Source: body reproduced VERBATIM from prod via pg_get_functiondef
-- (2026-06-10) per the CLAUDE.md "last wins" rule. Only two changes:
--   1. Whitelist: + 'tricicoin' (driver_cash stays for back-compat).
--   2. Defensive account creation: currency 'TRC' for tricicoin (matches
--      ensure_wallet_account / process_recharge_payment convention).
-- Everything else (auth gates, ledger writes, audit trail) is untouched.
-- ============================================================================

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
SET search_path TO 'public', 'pg_catalog'
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

  -- 00338: corporate_cash allowed. 00396: tricicoin allowed (single-wallet
  -- driver model — this is the balance accept_ride actually checks).
  IF p_account_type NOT IN ('customer_cash', 'driver_cash', 'corporate_cash', 'tricicoin') THEN
    RAISE EXCEPTION 'Unsupported account type: %', p_account_type;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
    WHERE user_id = p_target_user_id AND account_type = p_account_type LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (
      p_target_user_id, p_account_type, 0, 0,
      CASE WHEN p_account_type = 'tricicoin' THEN 'TRC' ELSE 'CUP' END,
      true
    )
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
  '00396: admin wallet adjustment. Whitelist: customer_cash, driver_cash (legacy), corporate_cash, tricicoin (live driver wallet). Auth: caller must be the admin passed as p_admin_user_id with role admin/super_admin. Double-entry: single signed ledger entry + audit row.';
