-- ============================================================
-- Sprint 9 — Payment Finalization Pipeline
-- platform_config, system user, calculate_ride_distance,
-- complete_ride_and_pay, auto_cancel_stale_searching_rides
-- ============================================================

-- ============================================================
-- A. Platform Config table
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'platform_config' AND policyname = 'pc_select') THEN
    CREATE POLICY "pc_select" ON platform_config FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'platform_config' AND policyname = 'pc_admin') THEN
    CREATE POLICY "pc_admin" ON platform_config FOR ALL USING (is_admin());
  END IF;
END $$;

INSERT INTO platform_config (key, value) VALUES
  ('commission_rate', '0.15'),
  ('search_timeout_seconds', '120')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- B. Platform system user + wallet account
-- ============================================================
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, confirmation_token, recovery_token
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  'platform@tricigo.system',
  crypt('not-a-real-password', gen_salt('bf')),
  NOW(), NOW(), NOW(), '', ''
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, phone, full_name, role, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '+0000000000',
  'TriciGo Platform',
  'super_admin',
  true
)
ON CONFLICT (id) DO NOTHING;

-- Create platform revenue wallet account
SELECT ensure_wallet_account(
  '00000000-0000-0000-0000-000000000001'::UUID,
  'platform_revenue'::wallet_account_type
);

-- ============================================================
-- C. Calculate ride distance from GPS trail
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_ride_distance(p_ride_id UUID)
RETURNS TABLE(distance_m INTEGER, point_count INTEGER) AS $$
DECLARE
  v_distance FLOAT := 0;
  v_count INTEGER := 0;
  v_prev GEOGRAPHY;
  v_curr GEOGRAPHY;
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT location
    FROM ride_location_events
    WHERE ride_id = p_ride_id
    ORDER BY recorded_at ASC
  LOOP
    v_count := v_count + 1;
    v_curr := rec.location;
    IF v_prev IS NOT NULL THEN
      v_distance := v_distance + ST_Distance(v_prev, v_curr);
    END IF;
    v_prev := v_curr;
  END LOOP;

  RETURN QUERY SELECT v_distance::INTEGER AS distance_m, v_count AS point_count;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- D. Complete ride and process payment (atomic)
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
  v_raw_fare INTEGER;
  v_fare INTEGER;
  v_final_fare INTEGER;
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

  -- 3. Calculate final fare
  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;
  v_raw_fare := ROUND(
    v_svc.base_fare_cup +
    (v_distance_km * v_svc.per_km_rate_cup) +
    (v_duration_min * v_svc.per_minute_rate_cup)
  );
  v_fare := GREATEST(v_raw_fare, v_svc.min_fare_cup);
  v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0);

  -- 4. Calculate commission
  SELECT (value::NUMERIC) INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_commission_amount := ROUND(v_final_fare * v_commission_rate);
  v_driver_earnings := v_final_fare - v_commission_amount;

  -- 5. Generate share_token
  v_share_token := encode(gen_random_bytes(12), 'hex');

  -- 6. Update ride record
  UPDATE rides SET
    status = 'completed',
    completed_at = NOW(),
    final_fare_cup = v_final_fare,
    actual_distance_m = p_actual_distance_m,
    actual_duration_s = p_actual_duration_s,
    share_token = v_share_token
  WHERE id = p_ride_id;

  -- 7. Insert final pricing snapshot
  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id
  ) VALUES (
    p_ride_id, 'final', v_svc.base_fare_cup, v_svc.per_km_rate_cup,
    v_svc.per_minute_rate_cup, p_actual_distance_m, p_actual_duration_s,
    1.00, v_fare, v_commission_rate, v_commission_amount, v_final_fare, NULL
  );

  -- 8. Process payment
  -- Get driver's user_id
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = p_driver_id;

  IF v_ride.payment_method = 'tricicoin' THEN
    -- === TRICICOIN PAYMENT ===
    -- Ensure all wallet accounts exist
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    -- Get current balances
    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    -- Create ledger transaction
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

    -- Customer debit
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_customer_account_id, -v_final_fare, v_customer_balance - v_final_fare);

    -- Driver credit
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);

    -- Platform commission credit
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    -- Update wallet balances
    UPDATE wallet_accounts SET balance = balance - v_final_fare WHERE id = v_customer_account_id;
    UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

  ELSE
    -- === CASH / MIXED PAYMENT ===
    -- Driver collects cash, platform takes commission from driver wallet
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    -- Create commission ledger transaction
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

    -- Driver commission debit
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, -v_commission_amount, v_driver_balance - v_commission_amount);

    -- Platform commission credit
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    -- Update wallet balances
    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;
  END IF;

  -- 9. Increment driver's completed rides count
  UPDATE driver_profiles
  SET total_rides_completed = total_rides_completed + 1
  WHERE id = p_driver_id;

  -- 10. Return result
  RETURN jsonb_build_object(
    'final_fare_cup', v_final_fare,
    'commission_amount', v_commission_amount,
    'driver_earnings', v_driver_earnings,
    'payment_method', v_ride.payment_method,
    'share_token', v_share_token
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- E. Auto-cancel stale searching rides
-- ============================================================
CREATE OR REPLACE FUNCTION auto_cancel_stale_searching_rides()
RETURNS INTEGER AS $$
DECLARE
  v_timeout INTEGER;
  v_count INTEGER;
BEGIN
  SELECT (value::INTEGER) INTO v_timeout
  FROM platform_config WHERE key = 'search_timeout_seconds';
  v_timeout := COALESCE(v_timeout, 120);

  UPDATE rides
  SET status = 'canceled',
      canceled_at = NOW(),
      cancellation_reason = 'search_timeout'
  WHERE status = 'searching'
    AND created_at < NOW() - (v_timeout || ' seconds')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
