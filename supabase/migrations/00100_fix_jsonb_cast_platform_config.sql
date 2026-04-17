-- Fix: JSONB string cannot be cast directly to NUMERIC
-- platform_config.value is JSONB. Values like '0.15' are stored as JSON strings ("0.15"),
-- not JSON numbers. Direct (value::NUMERIC) fails with "cannot cast jsonb string to type numeric".
-- Fix: use (value #>> '{}')::NUMERIC to extract the scalar text first.
--
-- Also fix: payment_method enum comparison with 'tropipay' (not yet in enum).
-- Cast payment_method to TEXT before comparing to avoid invalid enum literal error.

-- 1. Fix get_current_exchange_rate() fallback query
CREATE OR REPLACE FUNCTION get_current_exchange_rate()
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT usd_cup_rate INTO v_rate
  FROM exchange_rates
  WHERE is_current = true
  LIMIT 1;

  IF v_rate IS NULL THEN
    SELECT (value #>> '{}')::NUMERIC INTO v_rate
    FROM platform_config WHERE key = 'exchange_rate_fallback_cup';
    v_rate := COALESCE(v_rate, 520.0);
  END IF;

  RETURN v_rate;
END;
$$;

-- 2. Fix complete_ride_and_pay() commission_rate query
-- (Full function recreated — only change is the commission_rate SELECT line)
CREATE OR REPLACE FUNCTION complete_ride_and_pay(
  p_ride_id UUID,
  p_driver_id UUID,
  p_actual_distance_m INTEGER,
  p_actual_duration_s INTEGER
)
RETURNS JSONB AS $$
DECLARE
  v_ride RECORD;
  v_svc RECORD;
  v_commission_rate NUMERIC;
  v_distance_km NUMERIC;
  v_duration_min NUMERIC;
  v_effective_per_km INTEGER;
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
  v_platform_account_id UUID;
  v_customer_balance INTEGER;
  v_driver_balance INTEGER;
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

  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type AND is_active = true;
  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active service config for type: %', v_ride.service_type;
  END IF;

  v_surge := get_surge_multiplier(v_ride.pickup_location);

  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;
  v_effective_per_km := COALESCE(v_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);
  v_raw_fare := ROUND(v_svc.base_fare_cup + (v_distance_km * v_effective_per_km) + (v_duration_min * v_svc.per_minute_rate_cup));
  v_fare := GREATEST(ROUND(v_raw_fare * v_surge), v_svc.min_fare_cup);
  v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0);

  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, get_current_exchange_rate());
  v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);

  IF v_ride.insurance_selected = true AND v_ride.insurance_premium_cup > 0 THEN
    v_insurance_premium_trc := cup_to_trc_centavos(v_ride.insurance_premium_cup, v_exchange_rate);
  END IF;

  -- FIXED: extract JSONB scalar as text before casting to NUMERIC
  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);
  v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
  v_driver_earnings := v_final_fare_trc - v_commission_amount;

  v_share_token := encode(gen_random_bytes(12), 'hex');

  -- Cast enum to text to avoid invalid enum comparison for future payment methods
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
    share_token = v_share_token,
    payment_status = v_payment_status
  WHERE id = p_ride_id;

  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc
  ) VALUES (
    p_ride_id, 'final', v_svc.base_fare_cup, v_effective_per_km,
    v_svc.per_minute_rate_cup, p_actual_distance_m, p_actual_duration_s,
    v_surge, v_fare, v_commission_rate, v_commission_amount, v_final_fare, NULL,
    v_exchange_rate, v_final_fare_trc
  );

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = p_driver_id;

  IF v_payment_method_text = 'tricicoin' THEN
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
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

  ELSIF v_payment_method_text = 'tropipay' THEN
    NULL;

  ELSE
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'cash_commission:' || p_ride_id::TEXT,
      'commission', 'posted', 'ride', p_ride_id, 'Comision viaje efectivo #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, -v_commission_amount, v_driver_balance - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    IF v_insurance_premium_trc > 0 THEN
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

  UPDATE driver_profiles SET total_rides_completed = total_rides_completed + 1 WHERE id = p_driver_id;

  RETURN jsonb_build_object(
    'final_fare_cup', v_final_fare,
    'final_fare_trc', v_final_fare_trc,
    'exchange_rate_usd_cup', v_exchange_rate,
    'commission_amount', v_commission_amount,
    'driver_earnings', v_driver_earnings,
    'payment_method', v_ride.payment_method,
    'share_token', v_share_token,
    'surge_multiplier', v_surge,
    'driver_custom_rate_cup', v_ride.driver_custom_rate_cup,
    'payment_status', v_payment_status,
    'insurance_selected', v_ride.insurance_selected,
    'insurance_premium_cup', v_ride.insurance_premium_cup,
    'insurance_premium_trc', v_insurance_premium_trc
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
