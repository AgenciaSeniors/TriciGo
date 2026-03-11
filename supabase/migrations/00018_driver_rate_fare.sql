-- ============================================================
-- Migration 00018: Use driver's custom per-km rate in fare calculations
-- The driver sets their own price; the platform default is just a fallback.
-- ============================================================

-- Update complete_ride_and_pay to use driver_custom_rate_cup from the ride record
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
  v_effective_per_km INTEGER;   -- driver rate or platform default
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
  --    USE DRIVER'S CUSTOM RATE (snapshotted at acceptance), fall back to platform default
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

  -- 4. Get exchange rate (snapshot from ride creation, or fallback to current)
  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, get_current_exchange_rate());

  -- 5. Convert CUP to TRC centavos for wallet operations
  v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);

  -- 6. Calculate commission on TRC amount
  SELECT (value::NUMERIC) INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
  v_driver_earnings := v_final_fare_trc - v_commission_amount;

  -- 7. Generate share_token
  v_share_token := encode(gen_random_bytes(12), 'hex');

  -- 8. Update ride record with both CUP and TRC
  UPDATE rides SET
    status = 'completed',
    completed_at = NOW(),
    final_fare_cup = v_final_fare,
    final_fare_trc = v_final_fare_trc,
    exchange_rate_usd_cup = v_exchange_rate,
    actual_distance_m = p_actual_distance_m,
    actual_duration_s = p_actual_duration_s,
    share_token = v_share_token
  WHERE id = p_ride_id;

  -- 9. Insert final pricing snapshot (uses effective per-km rate, not platform default)
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

  -- 10. Process payment (all wallet ops in TRC centavos)
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

  -- 11. Increment driver's completed rides count
  UPDATE driver_profiles
  SET total_rides_completed = total_rides_completed + 1
  WHERE id = p_driver_id;

  -- 12. Return result with both CUP and TRC
  RETURN jsonb_build_object(
    'final_fare_cup', v_final_fare,
    'final_fare_trc', v_final_fare_trc,
    'exchange_rate_usd_cup', v_exchange_rate,
    'commission_amount', v_commission_amount,
    'driver_earnings', v_driver_earnings,
    'payment_method', v_ride.payment_method,
    'share_token', v_share_token,
    'surge_multiplier', v_surge,
    'driver_custom_rate_cup', v_ride.driver_custom_rate_cup
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
