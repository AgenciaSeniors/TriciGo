-- ============================================================
-- Migration 00024: TropiPay Direct Ride Payments
-- Adds 'tropipay' as a payment method for rides.
-- Payment is async: ride completes first, then customer pays
-- via TropiPay link. Webhook confirms and credits driver.
-- ============================================================

-- 1. Add payment_status column to rides for async payment tracking
ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_applicable';
-- Values: 'not_applicable' (cash/tricicoin — instant)
--         'pending'        (tropipay — awaiting payment)
--         'paid'           (tropipay — confirmed)
--         'failed'         (tropipay — error/expired)

-- 2. Add payment_intent_id to rides for linking to TropiPay intent
ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_intent_id UUID REFERENCES payment_intents(id);

-- 3. Index for finding rides with pending payments
CREATE INDEX IF NOT EXISTS idx_rides_payment_status_pending
  ON rides(payment_status) WHERE payment_status = 'pending';

-- 4. Add intent_type and ride_id to payment_intents
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS intent_type TEXT NOT NULL DEFAULT 'recharge';
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS ride_id UUID REFERENCES rides(id);

CREATE INDEX IF NOT EXISTS idx_payment_intents_ride
  ON payment_intents(ride_id) WHERE ride_id IS NOT NULL;

-- ============================================================
-- 5. Update complete_ride_and_pay() to handle 'tropipay' method
-- ============================================================
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
  v_final_fare INTEGER;        -- CUP whole pesos
  v_exchange_rate NUMERIC;
  v_final_fare_trc INTEGER;    -- TRC centavos
  v_commission_amount INTEGER; -- TRC centavos
  v_driver_earnings INTEGER;   -- TRC centavos
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
BEGIN
  -- 1. Lock and validate ride
  SELECT * INTO v_ride
  FROM rides
  WHERE id = p_ride_id
  FOR UPDATE;

  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found: %', p_ride_id;
  END IF;

  IF v_ride.status != 'in_progress' THEN
    RAISE EXCEPTION 'Ride % is not in_progress (current: %)', p_ride_id, v_ride.status;
  END IF;

  IF v_ride.driver_id != p_driver_id THEN
    RAISE EXCEPTION 'Driver % is not assigned to ride %', p_driver_id, p_ride_id;
  END IF;

  -- 2. Fetch service config for pricing
  SELECT * INTO v_svc
  FROM service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;

  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active service config for type: %', v_ride.service_type;
  END IF;

  -- 2b. Calculate surge multiplier from pickup location
  SELECT COALESCE(MAX(sz.multiplier), 1.0) INTO v_surge
  FROM surge_zones sz
  WHERE sz.is_active = true
    AND sz.starts_at <= NOW()
    AND sz.ends_at > NOW()
    AND ST_Contains(sz.geom, v_ride.pickup_location);

  -- 3. Calculate final fare in CUP whole pesos
  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;
  v_effective_per_km := COALESCE(v_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);
  v_raw_fare := ROUND(
    v_svc.base_fare_cup +
    (v_distance_km * v_effective_per_km) +
    (v_duration_min * v_svc.per_minute_rate_cup)
  );
  v_fare := GREATEST(ROUND(v_raw_fare * v_surge), v_svc.min_fare_cup);
  v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0);

  -- 4. Get exchange rate
  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, get_current_exchange_rate());

  -- 5. Convert CUP to TRC centavos
  v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);

  -- 6. Calculate commission
  SELECT (value::NUMERIC) INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
  v_driver_earnings := v_final_fare_trc - v_commission_amount;

  -- 7. Generate share_token
  v_share_token := encode(gen_random_bytes(12), 'hex');

  -- 8. Determine payment_status based on method
  IF v_ride.payment_method = 'tropipay' THEN
    v_payment_status := 'pending';
  ELSE
    v_payment_status := 'not_applicable';
  END IF;

  -- 9. Update ride record
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

  -- 10. Insert final pricing snapshot
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

  -- 11. Process payment based on method
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = p_driver_id;

  IF v_ride.payment_method = 'tricicoin' THEN
    -- === TRICICOIN PAYMENT ===
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id, description, created_by
    ) VALUES (
      gen_random_uuid(),
      'ride_payment:' || p_ride_id::TEXT,
      'ride_payment', 'posted', 'ride', p_ride_id,
      'Pago de viaje #' || LEFT(p_ride_id::TEXT, 8),
      v_ride.customer_id
    )
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

  ELSIF v_ride.payment_method = 'tropipay' THEN
    -- === TROPIPAY PAYMENT ===
    -- No ledger entries yet — payment is asynchronous.
    -- The actual ledger entries are created when the TropiPay webhook
    -- confirms payment via process_ride_tropipay_payment().
    NULL;

  ELSE
    -- === CASH / MIXED PAYMENT ===
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id, description, created_by
    ) VALUES (
      gen_random_uuid(),
      'cash_commission:' || p_ride_id::TEXT,
      'commission', 'posted', 'ride', p_ride_id,
      'Comision viaje efectivo #' || LEFT(p_ride_id::TEXT, 8),
      v_driver_user_id
    )
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, -v_commission_amount, v_driver_balance - v_commission_amount);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;
  END IF;

  -- 12. Increment driver's completed rides count
  UPDATE driver_profiles
  SET total_rides_completed = total_rides_completed + 1
  WHERE id = p_driver_id;

  -- 13. Return result
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
    'payment_status', v_payment_status
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 6. process_ride_tropipay_payment: Called when TropiPay webhook
--    confirms payment for a ride. Credits driver + platform.
-- ============================================================
CREATE OR REPLACE FUNCTION process_ride_tropipay_payment(
  p_payment_intent_id UUID,
  p_webhook_payload JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_ride RECORD;
  v_commission_rate NUMERIC;
  v_final_fare_trc INTEGER;
  v_commission_amount INTEGER;
  v_driver_earnings INTEGER;
  v_driver_user_id UUID;
  v_driver_account_id UUID;
  v_platform_account_id UUID;
  v_driver_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- 1. Lock the payment intent
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE id = p_payment_intent_id
  FOR UPDATE;

  IF v_intent IS NULL THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  -- Idempotent: already completed
  IF v_intent.status = 'completed' THEN
    RETURN v_intent.transaction_id;
  END IF;

  IF v_intent.status NOT IN ('created', 'pending') THEN
    RAISE EXCEPTION 'Payment intent % has invalid status: %',
      p_payment_intent_id, v_intent.status;
  END IF;

  IF v_intent.ride_id IS NULL THEN
    RAISE EXCEPTION 'Payment intent % has no ride_id', p_payment_intent_id;
  END IF;

  -- 2. Get ride details
  SELECT * INTO v_ride
  FROM rides
  WHERE id = v_intent.ride_id
  FOR UPDATE;

  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found for intent: %', v_intent.ride_id;
  END IF;

  IF v_ride.status != 'completed' THEN
    RAISE EXCEPTION 'Ride % is not completed (current: %)', v_ride.id, v_ride.status;
  END IF;

  -- 3. Get fare and commission from the ride
  v_final_fare_trc := v_ride.final_fare_trc;

  SELECT (value::NUMERIC) INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
  v_driver_earnings := v_final_fare_trc - v_commission_amount;

  -- 4. Get driver user_id
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = v_ride.driver_id;

  -- 5. Create ledger entries: credit driver + platform
  --    (No customer debit — TropiPay already collected from customer)
  v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

  SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id FOR UPDATE;
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, created_by
  ) VALUES (
    'tropipay_ride:' || v_ride.id::TEXT,
    'ride_payment',
    'posted',
    'ride',
    v_ride.id,
    'Pago TropiPay viaje #' || LEFT(v_ride.id::TEXT, 8),
    v_ride.customer_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

  UPDATE wallet_accounts SET balance = balance + v_driver_earnings, updated_at = NOW() WHERE id = v_driver_account_id;
  UPDATE wallet_accounts SET balance = balance + v_commission_amount, updated_at = NOW() WHERE id = v_platform_account_id;

  -- 6. Update ride payment_status
  UPDATE rides SET
    payment_status = 'paid',
    payment_intent_id = p_payment_intent_id
  WHERE id = v_ride.id;

  -- 7. Update payment intent
  UPDATE payment_intents SET
    status = 'completed',
    paid_at = NOW(),
    transaction_id = v_txn_id,
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$$;

-- ============================================================
-- 7. Enable realtime on rides.payment_status changes
-- ============================================================
-- (Supabase Realtime already subscribes to rides table changes,
--  so no additional setup needed for payment_status updates.)
