-- ============================================================
-- Migration 00340: complete_ride_and_pay — tricicoin + mixed wallet fix
--                  (PR-PAY-1, closes payment audit gaps 2026-05-28)
--
-- Context: payment methods `tricicoin` and `mixed` were credit-routed to
-- `driver_cash` (Gen A wallet, deprecated post PR #184). Drivers' visible
-- wallet `tricicoin` would never receive earnings. Both methods are
-- untested in prod (0 completed rides ever for tricicoin, 0 ever for
-- mixed) but the bugs were silent and would have surfaced as "no me
-- llegó el dinero del ride" support tickets the moment a real user
-- chose either method.
--
-- Bugs closed:
--
-- 1) Tricicoin branch credits wrong wallet
--    Before: v_driver_account_id := ensure_wallet_account(_, 'driver_cash')
--    After:  v_driver_account_id := ensure_wallet_account(_, 'tricicoin')
--    Impact: driver earnings now land in their visible wallet (tricicoin)
--            instead of the deprecated driver_cash wallet.
--
-- 2) Mixed branch double-counted earnings + wrong wallet
--    Before:
--      - Credited driver_cash with v_driver_earnings (FULL earnings on
--        total fare, e.g. 850 of 1000) → wrong wallet AND wrong amount
--        (driver already collects cash portion 500 in person)
--      - Debited tricicoin with v_commission_amount → only the commission
--        debit was visible to the driver, no earnings to offset it
--    After:
--      - Credit tricicoin with v_wallet_amount (the wallet portion only,
--        e.g. 500 of 1000) — this is what the customer paid via wallet
--      - Debit tricicoin with v_commission_amount — commission on full
--        fare (consistent with cash branch: driver pays commission of
--        total even when collecting partial cash)
--      - Cash portion (v_cash_amount) stays off-platform (driver collects
--        in person), no ledger movement
--    Net driver post-ride: +wallet_amount - commission in tricicoin,
--    +cash_amount in hand. Sum = driver_earnings (correct).
--
-- Wallet model context (verified prod 2026-05-28):
--   driver_profiles wallets:
--     - tricicoin (Gen B, post PR #184, visible) ← driver earnings land here
--     - driver_cash (Gen A, legacy, invisible) ← NOT touched anymore
--     - driver_quota (deprecated)
--   customer wallets:
--     - customer_cash (acts as "saldo TC" — the rider's TC pool)
--
-- This migration ONLY changes the tricicoin and mixed branches. All
-- other branches (cash, corporate, tropipay) are reproduced verbatim
-- and remain unchanged.
--
-- Verification post-apply (smoke test SQL):
--   1) Insert ride with payment_method='tricicoin', customer=Eduardo,
--      driver=Eduardo (diff devices), small fare
--   2) Snapshot balances of Eduardo's tricicoin/customer_cash/driver_cash
--      wallets + platform_revenue
--   3) Call complete_ride_and_pay(ride_id, ...)
--   4) Verify deltas:
--      - tricicoin: +driver_earnings
--      - customer_cash: -final_fare_trc
--      - driver_cash: UNCHANGED (was wrong before fix)
--      - platform_revenue: +commission_amount
--   5) Repeat for payment_method='mixed' with wallet_ratio=0.5
--      Verify:
--      - customer_cash: -wallet_amount
--      - tricicoin: +(wallet_amount - commission_amount)
--      - driver_cash: UNCHANGED
--      - platform_revenue: +commission_amount
--
-- Idempotent: CREATE OR REPLACE on the same signature.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(
  p_ride_id uuid,
  p_driver_id uuid,
  p_actual_distance_m integer,
  p_actual_duration_s integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_svc RECORD;
  v_est RECORD;
  v_commission_rate NUMERIC;
  v_distance_km NUMERIC;
  v_duration_min NUMERIC;
  v_eff_base_fare INTEGER;
  v_eff_per_km INTEGER;
  v_eff_per_min INTEGER;
  v_eff_min_fare INTEGER;
  v_eff_pricing_rule UUID;
  v_wait_charge INTEGER;
  v_raw_fare INTEGER;
  v_fare INTEGER;
  v_final_fare INTEGER;
  v_exchange_rate NUMERIC;
  v_final_fare_trc INTEGER;
  v_commission_amount INTEGER;
  v_driver_earnings INTEGER;
  v_share_token TEXT;
  v_driver_user_id UUID;
  v_customer_account_id UUID;
  v_driver_account_id UUID;
  v_driver_tricicoin_account_id UUID;
  v_platform_account_id UUID;
  v_customer_balance INTEGER;
  v_driver_balance INTEGER;
  v_driver_tricicoin_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_surge NUMERIC;
  v_payment_status TEXT;
  v_split RECORD;
  v_split_amount INTEGER;
  v_split_total INTEGER := 0;
  v_split_account_id UUID;
  v_split_balance INTEGER;
  v_insurance_premium_trc INTEGER := 0;
  v_payment_method_text TEXT;
  v_wallet_amount INTEGER;
  v_cash_amount INTEGER;
  v_default_commission_rate NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_original_final_fare INTEGER;
  v_distance_cap_factor NUMERIC := 1.3;
  v_chargeable_distance_m INTEGER;
  v_excess_m INTEGER;
  v_strict_parity BOOLEAN := false;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found: %', p_ride_id;
  END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RAISE EXCEPTION 'Ride % cannot be completed (current: %)', p_ride_id, v_ride.status;
  END IF;
  IF v_ride.driver_id != p_driver_id THEN
    RAISE EXCEPTION 'Driver % is not assigned to ride %', p_driver_id, p_ride_id;
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = p_driver_id;
  IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden: only the assigned driver can complete this ride';
  END IF;

  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type AND is_active = true;
  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active service config for type: %', v_ride.service_type;
  END IF;

  SELECT * INTO v_est
  FROM ride_pricing_snapshots
  WHERE ride_id = p_ride_id AND snapshot_type = 'estimate'
  LIMIT 1;

  v_strict_parity := (v_est.ride_id IS NOT NULL);

  v_eff_base_fare    := COALESCE(v_est.base_fare, v_svc.base_fare_cup);
  v_eff_per_km       := COALESCE(v_ride.driver_custom_rate_cup, v_est.per_km_rate, v_svc.per_km_rate_cup);
  v_eff_per_min      := COALESCE(v_est.per_minute_rate, v_svc.per_minute_rate_cup);
  v_eff_min_fare     := COALESCE(v_est.min_fare, v_svc.min_fare_cup);
  v_eff_pricing_rule := v_est.pricing_rule_id;
  v_surge := COALESCE(
    NULLIF(v_ride.surge_multiplier, 0),
    v_est.surge_multiplier,
    get_surge_multiplier(v_ride.pickup_location)
  );

  PERFORM calculate_wait_charge(p_ride_id);
  SELECT wait_time_charge_cup INTO v_wait_charge FROM rides WHERE id = p_ride_id;

  IF v_strict_parity THEN
    v_fare := v_est.total;
    v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0)
                  + COALESCE(v_wait_charge, 0);
    v_chargeable_distance_m := COALESCE(p_actual_distance_m, v_est.distance_m, 0);
    v_excess_m := 0;
  ELSE
    IF v_ride.estimated_distance_m IS NOT NULL AND v_ride.estimated_distance_m > 0 THEN
      v_chargeable_distance_m := LEAST(
        p_actual_distance_m,
        ROUND(v_ride.estimated_distance_m * v_distance_cap_factor)::INTEGER
      );
    ELSE
      v_chargeable_distance_m := p_actual_distance_m;
    END IF;
    v_excess_m := GREATEST(p_actual_distance_m - v_chargeable_distance_m, 0);

    v_distance_km := v_chargeable_distance_m / 1000.0;
    v_duration_min := v_distance_km * 60.0 / 40.0;

    v_raw_fare := ROUND(
      v_eff_base_fare
      + (v_distance_km * v_eff_per_km)
      + (v_duration_min * v_eff_per_min)
    );
    v_fare := GREATEST(ROUND(v_raw_fare * v_surge), v_eff_min_fare);
    v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0)
                  + COALESCE(v_wait_charge, 0);
  END IF;

  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, get_current_exchange_rate());
  v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);

  IF v_ride.insurance_selected = true AND v_ride.insurance_premium_cup > 0 THEN
    v_insurance_premium_trc := cup_to_trc_centavos(v_ride.insurance_premium_cup, v_exchange_rate);
  END IF;

  v_default_commission_rate := COALESCE(
    v_est.default_commission_rate_snapshot,
    (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'commission_rate'),
    0.15
  );
  v_commission_rate := v_default_commission_rate;

  IF v_ride.corporate_account_id IS NOT NULL THEN
    v_corp_commission_rate := COALESCE(
      v_est.corporate_commission_rate,
      (SELECT commission_percent / 100.0 FROM corporate_accounts WHERE id = v_ride.corporate_account_id)
    );

    IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_default_commission_rate THEN
      v_original_final_fare := v_final_fare;
      v_driver_earnings := v_original_final_fare - ROUND(v_original_final_fare * v_default_commission_rate);
      v_commission_amount := ROUND(v_original_final_fare * v_corp_commission_rate);
      v_final_fare := v_driver_earnings + v_commission_amount;
      v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);
      v_commission_rate := v_corp_commission_rate;
    ELSE
      v_commission_amount := ROUND(v_final_fare * v_commission_rate);
      v_driver_earnings := v_final_fare - v_commission_amount;
    END IF;
  ELSE
    v_commission_amount := ROUND(v_final_fare * v_commission_rate);
    v_driver_earnings := v_final_fare - v_commission_amount;
  END IF;

  v_share_token := encode(gen_random_bytes(12), 'hex');
  v_payment_method_text := v_ride.payment_method::TEXT;

  IF v_payment_method_text = 'tropipay' THEN
    v_payment_status := 'pending';
  ELSE
    v_payment_status := 'not_applicable';
  END IF;

  UPDATE rides SET
    status = 'completed',
    completed_at = NOW(),
    final_fare_cup = v_final_fare,
    final_fare_trc = v_final_fare_trc,
    exchange_rate_usd_cup = v_exchange_rate,
    actual_distance_m = p_actual_distance_m,
    actual_duration_s = p_actual_duration_s,
    excess_distance_uncharged_m = v_excess_m,
    share_token = v_share_token,
    payment_status = v_payment_status
  WHERE id = p_ride_id;

  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc,
    min_fare, corporate_commission_rate, default_commission_rate_snapshot
  ) VALUES (
    p_ride_id, 'final', v_eff_base_fare, v_eff_per_km,
    v_eff_per_min, v_chargeable_distance_m, p_actual_duration_s,
    v_surge, v_fare, v_commission_rate, v_commission_amount, v_final_fare, v_eff_pricing_rule,
    v_exchange_rate, v_final_fare_trc,
    v_eff_min_fare, v_corp_commission_rate, v_default_commission_rate
  );

  IF v_payment_method_text = 'tricicoin' THEN
    -- 00340 FIX: changed 'driver_cash' (Gen A deprecated) → 'tricicoin'
    -- so driver earnings land in their visible wallet.
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    IF v_ride.is_split THEN
      FOR v_split IN
        SELECT * FROM ride_splits WHERE ride_id = p_ride_id AND accepted_at IS NOT NULL ORDER BY created_at
      LOOP
        v_split_amount := ROUND(v_final_fare_trc * v_split.share_pct / 100);
        v_split_total := v_split_total + v_split_amount;
        v_split_account_id := ensure_wallet_account(v_split.user_id, 'customer_cash');
        SELECT balance INTO v_split_balance FROM wallet_accounts WHERE id = v_split_account_id FOR UPDATE;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'ride_split_payment:' || p_ride_id::TEXT || ':' || v_split.user_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id, 'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8), v_split.user_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_split_account_id, -v_split_amount, v_split_balance - v_split_amount);
        UPDATE wallet_accounts SET balance = balance - v_split_amount WHERE id = v_split_account_id;

        UPDATE ride_splits SET amount_trc = v_split_amount, payment_status = 'paid', paid_at = NOW() WHERE id = v_split.id;
      END LOOP;

      DECLARE v_requester_amount INTEGER;
      BEGIN
        v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
        v_requester_amount := v_final_fare_trc - v_split_total;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'ride_split_payment:' || p_ride_id::TEXT || ':' || v_ride.customer_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id, 'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_requester_amount, v_customer_balance - v_requester_amount);
        UPDATE wallet_accounts SET balance = balance - v_requester_amount WHERE id = v_customer_account_id;
      END;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'ride_driver_credit:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Ganancia conductor viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;

    ELSE
      v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'ride_payment:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Pago de viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_final_fare_trc, v_customer_balance - v_final_fare_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance - v_final_fare_trc WHERE id = v_customer_account_id;
      UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;
    END IF;

  ELSIF v_payment_method_text = 'mixed' THEN
    v_wallet_amount := ROUND(v_final_fare_trc * COALESCE(v_ride.wallet_ratio, 0));
    v_cash_amount := v_final_fare_trc - v_wallet_amount;

    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    -- 00340 FIX: changed 'driver_cash' (Gen A deprecated) → 'tricicoin'
    -- so driver wallet portion lands in their visible wallet.
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), v_customer_balance);
    v_cash_amount := v_final_fare_trc - v_wallet_amount;

    UPDATE rides SET
      wallet_amount_cup = v_wallet_amount,
      cash_amount_cup = v_cash_amount
    WHERE id = p_ride_id;

    IF v_wallet_amount > 0 THEN
      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'mixed_wallet_debit:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Pago mixto (wallet) viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_wallet_amount, v_customer_balance - v_wallet_amount);

      UPDATE wallet_accounts SET balance = balance - v_wallet_amount WHERE id = v_customer_account_id;
    END IF;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'mixed_driver_credit:' || p_ride_id::TEXT,
      'ride_payment', 'posted', 'ride', p_ride_id, 'Ganancia conductor mixto viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
    RETURNING id INTO v_txn_id;

    -- 00340 FIX: credit only the wallet PORTION (not full earnings) to
    -- tricicoin. Cash portion (v_cash_amount) is collected off-platform
    -- by the driver — no ledger entry. Commission still debits tricicoin
    -- (consistent with cash branch). Net driver in tricicoin:
    -- +v_wallet_amount - v_commission_amount.
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, v_wallet_amount, v_driver_tricicoin_balance + v_wallet_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, -v_commission_amount, v_driver_tricicoin_balance + v_wallet_amount - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance + v_wallet_amount - v_commission_amount WHERE id = v_driver_tricicoin_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    IF v_insurance_premium_trc > 0 THEN
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
      SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
        'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

      UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
      UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
    END IF;

  ELSIF v_payment_method_text = 'tropipay' THEN
    NULL;

  ELSIF v_payment_method_text = 'corporate' THEN
    NULL;

  ELSE
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'cash_commission:' || p_ride_id::TEXT,
      'commission', 'posted', 'ride', p_ride_id, 'Comision viaje efectivo #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, -v_commission_amount, v_driver_tricicoin_balance - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_tricicoin_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    IF v_insurance_premium_trc > 0 THEN
      v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
      SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
      SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
        'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, -v_insurance_premium_trc, v_driver_balance - v_insurance_premium_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

      UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
    END IF;
  END IF;

  UPDATE driver_profiles SET total_rides_completed = (
    SELECT COALESCE(count(*), 0)::int FROM rides WHERE driver_id = p_driver_id AND status = 'completed'
  ) WHERE id = p_driver_id;

  RETURN jsonb_build_object(
    'final_fare_cup', v_final_fare,
    'final_fare_trc', v_final_fare_trc,
    'exchange_rate_usd_cup', v_exchange_rate,
    'commission_amount', v_commission_amount,
    'driver_earnings', v_driver_earnings,
    'commission_rate', v_commission_rate,
    'is_corporate_discounted', (v_corp_commission_rate IS NOT NULL),
    'payment_method', v_ride.payment_method,
    'share_token', v_share_token,
    'surge_multiplier', v_surge,
    'driver_custom_rate_cup', v_ride.driver_custom_rate_cup,
    'payment_status', v_payment_status,
    'insurance_selected', v_ride.insurance_selected,
    'insurance_premium_cup', v_ride.insurance_premium_cup,
    'insurance_premium_trc', v_insurance_premium_trc,
    'wallet_amount_cup', COALESCE(v_wallet_amount, 0),
    'cash_amount_cup', COALESCE(v_cash_amount, 0),
    'wait_time_charge_cup', COALESCE(v_wait_charge, 0),
    'pricing_rule_id', v_eff_pricing_rule,
    'estimate_snapshot_present', v_strict_parity,
    'strict_parity_applied', v_strict_parity,
    'excess_distance_uncharged_m', COALESCE(v_excess_m, 0),
    'chargeable_distance_m', v_chargeable_distance_m,
    'actual_distance_m', p_actual_distance_m,
    'min_fare_used', v_eff_min_fare,
    'corporate_commission_rate_used', v_corp_commission_rate,
    'default_commission_rate_used', v_default_commission_rate
  );
END;
$function$;

COMMENT ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) IS
  '00340: fixes tricicoin + mixed branches. Both now credit driver tricicoin wallet (Gen B post PR #184) instead of deprecated driver_cash. Mixed only credits wallet portion (not full earnings) so cash portion stays off-platform.';
