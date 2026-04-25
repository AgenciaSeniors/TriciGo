-- ============================================================
-- Tier 10 batch: nine SECURITY DEFINER RPCs in `public` are
-- granted EXECUTE to authenticated and accept caller-identifying
-- parameters (p_from_user_id, p_admin_user_id, etc.) WITHOUT
-- validating that auth.uid() matches. Half of them have no
-- admin/owner check at all.
--
-- Without these gates, any authenticated user can:
--   - BUG-170: drain another user's wallet via transfer_wallet_p2p
--   - BUG-171: drain another user's wallet via add_tip
--   - BUG-172: rewrite the global USD/CUP exchange rate
--   - BUG-173: freeze any wallet (DoS)
--   - BUG-174: unfreeze any wallet (defeat admin freezes)
--   - BUG-175: approve their own pending recharge request without paying
--   - BUG-177: re-dispatch any ride (grief drivers, spam offers)
--   - BUG-178: impersonate an admin in admin_adjust_wallet,
--     admin_grant_grace_trips, admin_refund_ride_commission by
--     passing any known admin UUID as p_admin_user_id
--
-- Pattern across all fixes:
--   - For owner-scoped RPCs: assert auth.uid() = p_owner_param.
--   - For admin-scoped RPCs: assert auth.uid() = p_admin_param
--     AND that auth.uid() actually has admin role (via is_admin()).
--   - For cron-only RPCs: revoke EXECUTE from authenticated/anon.
-- ============================================================

-- ── BUG-170: transfer_wallet_p2p ─────────────────────────────
-- Caller must be the from-user (you can only transfer your own
-- money). Admins can transfer on behalf of anyone (rare; e.g.,
-- support refund flow).
CREATE OR REPLACE FUNCTION public.transfer_wallet_p2p(
  p_from_user_id uuid, p_to_user_id uuid, p_amount integer, p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_from_account_id UUID; v_to_account_id UUID;
  v_from_balance INTEGER; v_to_balance INTEGER;
  v_txn_id UUID; v_transfer_id UUID;
BEGIN
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only transfer from your own wallet';
  END IF;
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Transfer amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot transfer to yourself'; END IF;

  PERFORM ensure_wallet_account(p_from_user_id, 'customer_cash');
  PERFORM ensure_wallet_account(p_to_user_id, 'customer_cash');
  SELECT id, balance INTO v_from_account_id, v_from_balance FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type='customer_cash' FOR UPDATE;
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;
  SELECT id, balance INTO v_to_account_id, v_to_balance FROM wallet_accounts
    WHERE user_id = p_to_user_id AND account_type='customer_cash' FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, description, created_by)
  VALUES ('p2p:' || gen_random_uuid(), 'transfer_out', 'posted', 'wallet_transfer',
          COALESCE(p_note, 'Transferencia P2P'), p_from_user_id)
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);
  UPDATE wallet_accounts SET balance = v_from_balance - p_amount, updated_at = NOW()
    WHERE id = v_from_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);
  UPDATE wallet_accounts SET balance = v_to_balance + p_amount, updated_at = NOW()
    WHERE id = v_to_account_id;
  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id)
    VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id)
  RETURNING id INTO v_transfer_id;
  RETURN v_transfer_id;
END;
$$;

-- ── BUG-171: add_tip ─────────────────────────────────────────
-- Caller must be the from-user (only tip from your own wallet).
CREATE OR REPLACE FUNCTION public.add_tip(p_ride_id uuid, p_from_user_id uuid, p_amount integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride RECORD; v_driver_user_id UUID;
  v_from_account_id UUID; v_driver_account_id UUID;
  v_tip_id UUID; v_txn_id UUID;
BEGIN
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only tip from your own wallet';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id AND status = 'completed';
  IF v_ride IS NULL THEN RAISE EXCEPTION 'Ride not found or not completed'; END IF;

  -- Caller must also be the customer of the ride (admins can override).
  IF NOT is_admin() AND v_ride.customer_id <> auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: only the rider can tip on this ride';
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = v_ride.driver_id;
  IF v_driver_user_id IS NULL THEN RAISE EXCEPTION 'Driver not found'; END IF;

  SELECT id INTO v_from_account_id FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = 'customer_cash';
  IF v_from_account_id IS NULL THEN RAISE EXCEPTION 'Customer wallet not found'; END IF;

  IF (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for tip';
  END IF;

  SELECT id INTO v_driver_account_id FROM wallet_accounts
    WHERE user_id = v_driver_user_id AND account_type = 'driver_cash';
  IF v_driver_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_driver_user_id, 'driver_cash', 0, 0, 'TRC', true)
    RETURNING id INTO v_driver_account_id;
  END IF;

  INSERT INTO tips (ride_id, from_user_id, to_driver_id, amount)
  VALUES (p_ride_id, p_from_user_id, v_driver_user_id, p_amount)
  RETURNING id INTO v_tip_id;

  UPDATE rides SET tip_amount = COALESCE(tip_amount, 0) + p_amount WHERE id = p_ride_id;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES ('tip:' || v_tip_id, 'adjustment', 'posted', 'tip', v_tip_id,
          'Propina viaje #' || LEFT(p_ride_id::TEXT, 8), p_from_user_id)
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_from_account_id, -p_amount,
          (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) - p_amount);
  UPDATE wallet_accounts SET balance = balance - p_amount WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_driver_account_id, p_amount,
          (SELECT balance FROM wallet_accounts WHERE id = v_driver_account_id) + p_amount);
  UPDATE wallet_accounts SET balance = balance + p_amount WHERE id = v_driver_account_id;

  RETURN v_tip_id;
END;
$$;

-- ── BUG-172: upsert_exchange_rate — cron-only ───────────────
-- Should only be called by service_role (sync-exchange-rate EF).
-- Revoke EXECUTE from anon and authenticated.
REVOKE EXECUTE ON FUNCTION public.upsert_exchange_rate(text, numeric, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;

-- ── BUG-173 + BUG-174: freeze_wallet / unfreeze_wallet ───────
CREATE OR REPLACE FUNCTION public.freeze_wallet(p_user_id uuid, p_reason text, p_admin_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required (and p_admin_id must match caller)';
  END IF;

  UPDATE wallet_accounts
  SET is_frozen = true, frozen_reason = p_reason,
      frozen_at = NOW(), frozen_by = p_admin_id
  WHERE user_id = p_user_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, details)
  VALUES (p_admin_id, 'freeze_wallet', 'user', p_user_id,
    jsonb_build_object('reason', p_reason));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.unfreeze_wallet(p_user_id uuid, p_admin_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required (and p_admin_id must match caller)';
  END IF;

  UPDATE wallet_accounts
  SET is_frozen = false, frozen_reason = NULL,
      frozen_at = NULL, frozen_by = NULL
  WHERE user_id = p_user_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id)
  VALUES (p_admin_id, 'unfreeze_wallet', 'user', p_user_id);
  RETURN true;
END;
$$;

-- ── BUG-175: approve_wallet_recharge ─────────────────────────
CREATE OR REPLACE FUNCTION public.approve_wallet_recharge(p_request_id uuid, p_admin_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_req RECORD; v_account_id UUID; v_current_balance INTEGER;
  v_txn_id UUID; v_idempotency_key TEXT;
BEGIN
  IF auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required (and p_admin_id must match caller)';
  END IF;

  SELECT * INTO v_req FROM wallet_recharge_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Recharge request not found: %', p_request_id; END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Recharge request % is not pending (status: %)', p_request_id, v_req.status;
  END IF;
  IF v_req.amount <= 0 THEN RAISE EXCEPTION 'Recharge amount must be positive, got %', v_req.amount; END IF;

  v_idempotency_key := 'recharge:' || p_request_id::TEXT;
  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE wallet_recharge_requests SET status='approved', processed_by=p_admin_id,
           processed_at=COALESCE(processed_at, NOW())
    WHERE id = p_request_id;
    RETURN v_txn_id;
  END IF;

  v_account_id := ensure_wallet_account(v_req.user_id, 'customer_cash');
  SELECT balance INTO v_current_balance FROM wallet_accounts WHERE id = v_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES (v_idempotency_key, 'recharge', 'posted', 'recharge_request', p_request_id,
          'Recarga wallet #' || LEFT(p_request_id::TEXT, 8), p_admin_id)
  RETURNING id INTO v_txn_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_req.amount, v_current_balance + v_req.amount);
  UPDATE wallet_accounts SET balance = v_current_balance + v_req.amount, updated_at = NOW()
  WHERE id = v_account_id;
  UPDATE wallet_recharge_requests SET status='approved', processed_by=p_admin_id, processed_at=NOW()
  WHERE id = p_request_id;
  RETURN v_txn_id;
END;
$$;

-- ── BUG-177: dispatch_ride — internal/admin only ─────────────
-- Called from on_ride_insert_dispatch trigger and retry_dispatch_expired_rides
-- cron. App code never invokes it directly. Lock to service_role + admin.
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride        rides%ROWTYPE;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_is_delivery boolean;
  v_count       int := 0;
  v_round       int;
  v_offer_ttl_s int;
BEGIN
  -- Allow when called from another SECDEF (trigger / cron / RPC chain)
  -- but reject direct authenticated calls. pg_trigger_depth() > 0 means
  -- inside a trigger; current_user='postgres' means inside a SECDEF.
  IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');
  v_round := v_ride.dispatch_round + 1;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(v_pickup_lat, v_pickup_lng, v_ride.service_type, 10, p_radius_m, v_is_delivery) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  IF v_count = 0 AND v_round = 1 THEN
    UPDATE rides SET status = 'canceled', canceled_at = now(),
                     cancellation_reason = 'no_drivers_available'
    WHERE id = p_ride_id AND status = 'searching';
  END IF;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
    'dispatch_round', v_round, 'radius_m', p_radius_m, 'offer_ttl_s', v_offer_ttl_s);
END;
$$;

-- ── BUG-178: admin RPCs require auth.uid() = p_admin_user_id ─
-- The existing role check on p_admin_user_id is bypassable: an
-- attacker who knows ANY admin's UUID can pass it as p_admin_user_id
-- and the role check passes. Add the missing auth.uid() match.
CREATE OR REPLACE FUNCTION public.admin_adjust_wallet(
  p_target_user_id uuid, p_account_type wallet_account_type, p_amount_cup integer,
  p_reason text, p_admin_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_account_id UUID; v_new_balance INTEGER; v_tx_id UUID; v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN RAISE EXCEPTION 'Forbidden: admin role required'; END IF;
  IF p_amount_cup = 0 THEN RAISE EXCEPTION 'Amount cannot be zero'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'Reason is required (min 3 chars)'; END IF;
  IF p_account_type NOT IN ('customer_cash', 'driver_cash') THEN
    RAISE EXCEPTION 'Unsupported account type: %', p_account_type;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
    WHERE user_id = p_target_user_id AND account_type = p_account_type LIMIT 1;
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (p_target_user_id, p_account_type, 0, 0, 'CUP', true)
    RETURNING id INTO v_account_id;
  END IF;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES ('admin_adjust:' || gen_random_uuid()::TEXT, 'adjustment', 'posted', 'admin_action',
          p_admin_user_id, p_reason, p_admin_user_id)
  RETURNING id INTO v_tx_id;

  UPDATE wallet_accounts SET balance = balance + p_amount_cup, updated_at = NOW()
  WHERE id = v_account_id RETURNING balance INTO v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_account_id, p_amount_cup, v_new_balance);

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_user_id, 'adjust_wallet', 'wallet_account', v_account_id::TEXT, p_reason);

  RETURN jsonb_build_object('transaction_id', v_tx_id, 'account_id', v_account_id,
    'amount_cup', p_amount_cup, 'new_balance', v_new_balance);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_grant_grace_trips(
  p_driver_user_id uuid, p_trips integer, p_admin_user_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE v_new_total INTEGER; v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
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
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_refund_ride_commission(
  p_ride_id uuid, p_admin_user_id uuid, p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_driver_user_id UUID; v_commission_amount INTEGER; v_result JSONB; v_is_admin BOOLEAN;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
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
  IF v_commission_amount IS NULL OR v_commission_amount = 0 THEN
    RAISE EXCEPTION 'No commission to refund on this ride';
  END IF;

  v_result := admin_adjust_wallet(v_driver_user_id, 'driver_cash'::wallet_account_type,
    v_commission_amount, 'Refund ride ' || p_ride_id::TEXT || ': ' || p_reason, p_admin_user_id);
  RETURN v_result;
END;
$$;
