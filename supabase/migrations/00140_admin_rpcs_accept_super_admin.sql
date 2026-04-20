-- ============================================================
-- Migration 00140: admin_* RPCs — 3 bugs consolidados
--
-- El RPC admin_adjust_wallet (y sus primos grace_trips /
-- refund_ride_commission) de migration 00133 tenía TRES bugs que
-- hacían imposible usarlos desde el admin:
--
-- 1) Check literal `role = 'admin'` rechazaba super_admin.
--    Fix: aceptar IN ('admin', 'super_admin').
--
-- 2) INSERT INTO ledger_transactions con `status = 'completed'`,
--    pero el enum ledger_transaction_status solo tiene
--    'pending', 'posted', 'archived', 'reversed'.
--    Fix: usar 'posted' (transacción confirmada en el ledger).
--
-- 3) INSERT INTO ledger_transactions omitía `idempotency_key`,
--    que es NOT NULL. Fix: generar uno único por llamada con
--    'admin_adjust:' || gen_random_uuid().
--
-- Estos 3 bugs estuvieron vivos en prod desde que se aplicó
-- 00133. Ningún super_admin pudo ajustar saldos durante ese
-- tiempo.
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
AS $function$
DECLARE
  v_account_id UUID;
  v_new_balance INTEGER;
  v_tx_id UUID;
  v_is_admin BOOLEAN;
BEGIN
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN RAISE EXCEPTION 'Forbidden: admin role required'; END IF;
  IF p_amount_cup = 0 THEN RAISE EXCEPTION 'Amount cannot be zero'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'Reason is required (min 3 chars)'; END IF;
  IF p_account_type NOT IN ('customer_cash', 'driver_cash') THEN RAISE EXCEPTION 'Unsupported account type: %', p_account_type; END IF;

  SELECT id INTO v_account_id FROM wallet_accounts WHERE user_id = p_target_user_id AND account_type = p_account_type LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_target_user_id, p_account_type, 0, 0, 'CUP', true) RETURNING id INTO v_account_id;
  END IF;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES ('admin_adjust:' || gen_random_uuid()::TEXT, 'adjustment', 'posted', 'admin_action', p_admin_user_id, p_reason, p_admin_user_id)
  RETURNING id INTO v_tx_id;

  UPDATE wallet_accounts SET balance = balance + p_amount_cup, updated_at = NOW()
  WHERE id = v_account_id RETURNING balance INTO v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount_cup, v_new_balance);

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'adjust_wallet', 'wallet_account', v_account_id::TEXT, p_reason);

  RETURN jsonb_build_object('transaction_id', v_tx_id, 'account_id', v_account_id, 'amount_cup', p_amount_cup, 'new_balance', v_new_balance);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_grant_grace_trips(
  p_driver_user_id uuid, p_trips integer, p_admin_user_id uuid, p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_new_total INTEGER; v_is_admin BOOLEAN;
BEGIN
  SELECT (role IN ('admin','super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN RAISE EXCEPTION 'Forbidden: admin role required'; END IF;
  IF p_trips = 0 THEN RAISE EXCEPTION 'Trips cannot be zero'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'Reason is required'; END IF;

  UPDATE driver_profiles SET grace_trips_remaining = GREATEST(COALESCE(grace_trips_remaining, 0) + p_trips, 0)
  WHERE user_id = p_driver_user_id RETURNING grace_trips_remaining INTO v_new_total;
  IF v_new_total IS NULL THEN RAISE EXCEPTION 'Driver profile not found'; END IF;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'grant_grace_trips', 'driver_profile', p_driver_user_id::TEXT,
          p_trips::TEXT || ' trips: ' || p_reason);
  RETURN jsonb_build_object('driver_user_id', p_driver_user_id, 'trips_added', p_trips, 'new_total', v_new_total);
END; $$;

CREATE OR REPLACE FUNCTION public.admin_refund_ride_commission(
  p_ride_id uuid, p_admin_user_id uuid, p_reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_driver_user_id UUID; v_commission_amount INTEGER; v_result JSONB; v_is_admin BOOLEAN;
BEGIN
  SELECT (role IN ('admin','super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN RAISE EXCEPTION 'Forbidden: admin role required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'Reason is required'; END IF;

  SELECT dp.user_id INTO v_driver_user_id
  FROM rides r JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;
  IF v_driver_user_id IS NULL THEN RAISE EXCEPTION 'Ride not found or has no driver'; END IF;

  SELECT SUM(ABS(le.amount))::INTEGER INTO v_commission_amount
  FROM ledger_transactions lt
  JOIN ledger_entries le ON le.transaction_id = lt.id
  JOIN wallet_accounts wa ON wa.id = le.account_id
  WHERE lt.type = 'commission' AND lt.reference_id = p_ride_id
    AND wa.user_id = v_driver_user_id AND wa.account_type = 'driver_cash'
    AND le.amount < 0;
  IF v_commission_amount IS NULL OR v_commission_amount = 0 THEN RAISE EXCEPTION 'No commission to refund on this ride'; END IF;

  v_result := admin_adjust_wallet(v_driver_user_id, 'driver_cash'::wallet_account_type, v_commission_amount,
    'Refund ride ' || p_ride_id::TEXT || ': ' || p_reason, p_admin_user_id);
  RETURN v_result;
END; $$;
