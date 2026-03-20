-- ============================================================================
-- Migration 00053: Fix Database Bugs
-- ============================================================================
-- Fixes 6 confirmed bugs found during exhaustive DB audit:
--   DB1: trusted_contacts trigger references non-existent function
--   DB2: notifications INSERT policy blocks service_role
--   DB3: complete_ride_and_pay() surge query references non-existent columns
--   DB4: review rating trigger only fires on INSERT, not UPDATE
--   DB5: ride_splits.share_pct missing CHECK constraint
--   DB6: Missing index on ledger_entries.account_id
-- ============================================================================

-- ---------------------------------------------------------------------------
-- DB1: Fix trusted_contacts updated_at trigger
-- ---------------------------------------------------------------------------
-- The trigger in 00034 calls update_updated_at() but the function is actually
-- named update_updated_at_column() (defined in 00004_feature_flags.sql).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON trusted_contacts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON trusted_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- DB2: Fix notifications INSERT policy to allow service_role
-- ---------------------------------------------------------------------------
-- The original policy only allows is_admin(), but Edge Functions (send-push)
-- run as service_role and cannot insert notifications.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "notification_insert" ON notifications;
CREATE POLICY "notification_insert" ON notifications FOR INSERT WITH CHECK (
  is_admin() OR current_setting('role', true) = 'service_role'
);

-- ---------------------------------------------------------------------------
-- DB3: Fix surge pricing query in complete_ride_and_pay()
-- ---------------------------------------------------------------------------
-- The surge query uses sz.geom (doesn't exist) and sz.is_active (column is
-- actually named "active"). surge_zones has zone_id FK to zones table which
-- has the boundary geometry column.
--
-- Fix: JOIN surge_zones with zones table and use z.boundary for ST_Contains,
-- and reference sz.active instead of sz.is_active.
--
-- We recreate complete_ride_and_pay() with the fix applied. This is the
-- version from 00037 (latest) with the surge query corrected.
-- ---------------------------------------------------------------------------

-- Create a reusable helper for correct surge lookup (also useful for estimate APIs)
CREATE OR REPLACE FUNCTION get_surge_multiplier(p_pickup_location GEOGRAPHY)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_surge NUMERIC;
BEGIN
  SELECT COALESCE(MAX(sz.multiplier), 1.0) INTO v_surge
  FROM surge_zones sz
  JOIN zones z ON z.id = sz.zone_id
  WHERE sz.active = true
    AND sz.starts_at <= NOW()
    AND sz.ends_at > NOW()
    AND ST_Contains(z.boundary::geometry, p_pickup_location::geometry);

  RETURN v_surge;
END;
$$;

-- Now patch complete_ride_and_pay() to use the helper instead of the broken
-- inline surge query. This replaces the version from 00037.
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
  -- Split variables
  v_split RECORD;
  v_split_amount INTEGER;
  v_split_total INTEGER := 0;
  v_split_account_id UUID;
  v_split_balance INTEGER;
  -- Insurance variables
  v_insurance_premium_trc INTEGER := 0;
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

  -- 2b. Calculate surge multiplier (FIXED: uses helper with correct JOIN)
  v_surge := get_surge_multiplier(v_ride.pickup_location);

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

  -- 5b. Convert insurance premium CUP to TRC (if selected)
  IF v_ride.insurance_selected = true AND v_ride.insurance_premium_cup > 0 THEN
    v_insurance_premium_trc := cup_to_trc_centavos(v_ride.insurance_premium_cup, v_exchange_rate);
  END IF;

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
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    IF v_ride.is_split THEN
      -- === SPLIT PAYMENT ===
      FOR v_split IN
        SELECT * FROM ride_splits
        WHERE ride_id = p_ride_id AND accepted_at IS NOT NULL
        ORDER BY created_at
      LOOP
        v_split_amount := ROUND(v_final_fare_trc * v_split.share_pct / 100);
        v_split_total := v_split_total + v_split_amount;

        v_split_account_id := ensure_wallet_account(v_split.user_id, 'customer_cash');
        SELECT balance INTO v_split_balance FROM wallet_accounts WHERE id = v_split_account_id FOR UPDATE;

        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status, reference_type, reference_id, description, created_by
        ) VALUES (
          gen_random_uuid(),
          'ride_split_payment:' || p_ride_id::TEXT || ':' || v_split.user_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id,
          'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8),
          v_split.user_id
        )
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_split_account_id, -v_split_amount, v_split_balance - v_split_amount);

        UPDATE wallet_accounts SET balance = balance - v_split_amount WHERE id = v_split_account_id;

        UPDATE ride_splits SET
          amount_trc = v_split_amount,
          payment_status = 'paid',
          paid_at = NOW()
        WHERE id = v_split.id;
      END LOOP;

      -- Requester pays the remainder
      v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;

      DECLARE v_requester_amount INTEGER;
      BEGIN
        v_requester_amount := v_final_fare_trc - v_split_total;

        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status, reference_type, reference_id, description, created_by
        ) VALUES (
          gen_random_uuid(),
          'ride_split_payment:' || p_ride_id::TEXT || ':' || v_ride.customer_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id,
          'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8),
          v_ride.customer_id
        )
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_requester_amount, v_customer_balance - v_requester_amount);

        UPDATE wallet_accounts SET balance = balance - v_requester_amount WHERE id = v_customer_account_id;
      END;

      -- Credit driver and platform
      INSERT INTO ledger_transactions (
        id, idempotency_key, type, status, reference_type, reference_id, description, created_by
      ) VALUES (
        gen_random_uuid(),
        'ride_driver_credit:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id,
        'Ganancia conductor viaje #' || LEFT(p_ride_id::TEXT, 8),
        v_driver_user_id
      )
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

      -- === INSURANCE PREMIUM (split: charge requester only) ===
      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status, reference_type, reference_id, description, created_by
        ) VALUES (
          gen_random_uuid(),
          'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id,
          'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8),
          v_ride.customer_id
        )
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;

    ELSE
      -- === SINGLE CUSTOMER PAYMENT (original flow) ===
      v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;

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

      -- === INSURANCE PREMIUM (single payer) ===
      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status, reference_type, reference_id, description, created_by
        ) VALUES (
          gen_random_uuid(),
          'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id,
          'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8),
          v_ride.customer_id
        )
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;
    END IF;

  ELSIF v_ride.payment_method = 'tropipay' THEN
    -- === TROPIPAY PAYMENT ===
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

    -- === INSURANCE PREMIUM (cash: debit driver who collected cash, credit platform) ===
    IF v_insurance_premium_trc > 0 THEN
      SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
      SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

      INSERT INTO ledger_transactions (
        id, idempotency_key, type, status, reference_type, reference_id, description, created_by
      ) VALUES (
        gen_random_uuid(),
        'insurance_premium:' || p_ride_id::TEXT,
        'insurance_premium', 'posted', 'ride', p_ride_id,
        'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8),
        v_driver_user_id
      )
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, -v_insurance_premium_trc, v_driver_balance - v_insurance_premium_trc);

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

      UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
    END IF;
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
    'payment_status', v_payment_status,
    'insurance_selected', v_ride.insurance_selected,
    'insurance_premium_cup', v_ride.insurance_premium_cup,
    'insurance_premium_trc', v_insurance_premium_trc
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- DB4: Fix review rating trigger to fire on UPDATE too
-- ---------------------------------------------------------------------------
-- Original trigger (00026) only fires on INSERT. If a review is edited,
-- customer_profiles.rating_avg becomes stale.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_update_customer_rating ON reviews;
CREATE TRIGGER trg_update_customer_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_customer_rating_avg();

-- ---------------------------------------------------------------------------
-- DB5: Add CHECK constraint on ride_splits.share_pct
-- ---------------------------------------------------------------------------
-- share_pct NUMERIC(5,2) allows negative values and values > 100.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'chk_share_pct'
  ) THEN
    ALTER TABLE ride_splits ADD CONSTRAINT chk_share_pct
      CHECK (share_pct >= 0 AND share_pct <= 100);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- DB6: Add index on ledger_entries.account_id
-- ---------------------------------------------------------------------------
-- RLS policies and wallet queries filter by account_id but no index exists.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id
  ON ledger_entries(account_id);
