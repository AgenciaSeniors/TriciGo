-- ============================================================
-- Migration 00017: Exchange Rate Billing Model
-- 1 TRC = 1 USD, drivers price in CUP, exchange rate from ElToque
-- ============================================================

-- 1A. Create exchange_rates table (history + current rate)
CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('eltoque_api', 'manual')),
  usd_cup_rate NUMERIC NOT NULL,           -- e.g. 520.00 means 1 USD = 520 CUP
  fetched_at TIMESTAMPTZ NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one row can be is_current=true at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_rates_current
  ON exchange_rates (is_current) WHERE is_current = true;

-- Seed with initial manual rate (1 USD = 520 CUP)
INSERT INTO exchange_rates (source, usd_cup_rate, fetched_at, is_current)
VALUES ('manual', 520.00, NOW(), true);

-- RLS
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "er_select" ON exchange_rates FOR SELECT USING (true);
-- INSERT/UPDATE only via service_role (edge functions, admin API)

-- 1B. New platform_config entries
INSERT INTO platform_config (key, value) VALUES
  ('eltoque_api_token', '""'),
  ('exchange_rate_auto_update', '"true"'),
  ('exchange_rate_fallback_cup', '520')
ON CONFLICT (key) DO NOTHING;

-- Rename default_per_km_rate_trc -> default_per_km_rate_cup with CUP value
UPDATE platform_config
SET key = 'default_per_km_rate_cup', value = '150'
WHERE key = 'default_per_km_rate_trc';

-- 1C. Update service_type_configs to CUP whole pesos
-- Triciclo: base=100, per_km=150, per_min=15, min=150
UPDATE service_type_configs
SET base_fare_cup = 100, per_km_rate_cup = 150,
    per_minute_rate_cup = 15, min_fare_cup = 150
WHERE slug LIKE 'triciclo%';

-- Moto: base=80, per_km=120, per_min=10, min=100
UPDATE service_type_configs
SET base_fare_cup = 80, per_km_rate_cup = 120,
    per_minute_rate_cup = 10, min_fare_cup = 100
WHERE slug = 'moto_standard';

-- Auto: base=100, per_km=200, per_min=15, min=200
UPDATE service_type_configs
SET base_fare_cup = 100, per_km_rate_cup = 200,
    per_minute_rate_cup = 15, min_fare_cup = 200
WHERE slug = 'auto_standard';

-- 1C-bis. Update pricing_rules to match new CUP values
UPDATE pricing_rules SET base_fare_cup=100, per_km_rate_cup=150, per_minute_rate_cup=15, min_fare_cup=150
WHERE service_type = 'triciclo_basico';
UPDATE pricing_rules SET base_fare_cup=80, per_km_rate_cup=120, per_minute_rate_cup=10, min_fare_cup=100
WHERE service_type = 'moto_standard';
UPDATE pricing_rules SET base_fare_cup=100, per_km_rate_cup=200, per_minute_rate_cup=15, min_fare_cup=200
WHERE service_type = 'auto_standard';

-- 1D. Rename and reset driver custom rate column
UPDATE driver_profiles SET custom_per_km_rate = NULL
WHERE custom_per_km_rate IS NOT NULL;

ALTER TABLE driver_profiles
  RENAME COLUMN custom_per_km_rate TO custom_per_km_rate_cup;

COMMENT ON COLUMN driver_profiles.custom_per_km_rate_cup
  IS 'Driver per-km rate in CUP whole pesos. NULL = use default from service_type_configs.';

-- 1E. Add exchange rate + TRC fare columns to rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS exchange_rate_usd_cup NUMERIC DEFAULT NULL;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS estimated_fare_trc INTEGER DEFAULT NULL;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS final_fare_trc INTEGER DEFAULT NULL;

-- Rename driver_custom_rate_trc -> driver_custom_rate_cup
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rides' AND column_name = 'driver_custom_rate_trc'
  ) THEN
    ALTER TABLE rides RENAME COLUMN driver_custom_rate_trc TO driver_custom_rate_cup;
  END IF;
END;
$$;

-- Add exchange_rate to ride_pricing_snapshots
ALTER TABLE ride_pricing_snapshots
  ADD COLUMN IF NOT EXISTS exchange_rate_usd_cup NUMERIC DEFAULT NULL;
ALTER TABLE ride_pricing_snapshots
  ADD COLUMN IF NOT EXISTS total_trc INTEGER DEFAULT NULL;

-- 1F. Helper function: get current exchange rate
CREATE OR REPLACE FUNCTION get_current_exchange_rate()
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT usd_cup_rate INTO v_rate
  FROM exchange_rates
  WHERE is_current = true
  LIMIT 1;

  IF v_rate IS NULL THEN
    -- Fallback to platform_config
    SELECT (value::NUMERIC) INTO v_rate
    FROM platform_config WHERE key = 'exchange_rate_fallback_cup';
    v_rate := COALESCE(v_rate, 520.0);
  END IF;

  RETURN v_rate;
END;
$$;

-- Helper function: convert CUP whole pesos to TRC centavos
CREATE OR REPLACE FUNCTION cup_to_trc_centavos(
  p_cup_pesos NUMERIC,
  p_exchange_rate NUMERIC
)
RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  -- cup_pesos / rate = USD = TRC, then * 100 for centavos
  -- e.g. 750 CUP / 520 = 1.4423 TRC = 144 centavos
  RETURN ROUND((p_cup_pesos / p_exchange_rate) * 100);
END;
$$;

GRANT EXECUTE ON FUNCTION get_current_exchange_rate TO anon, authenticated;
GRANT EXECUTE ON FUNCTION cup_to_trc_centavos TO anon, authenticated;

-- 1G. Update find_nearby_vehicles to use renamed column
DROP FUNCTION IF EXISTS find_nearby_vehicles(DOUBLE PRECISION, DOUBLE PRECISION, TEXT, INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION find_nearby_vehicles(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_vehicle_type TEXT DEFAULT NULL,
  p_radius_m INTEGER DEFAULT 5000,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  driver_profile_id UUID,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  vehicle_type TEXT,
  custom_per_km_rate_cup INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_center GEOGRAPHY;
BEGIN
  v_center := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  RETURN QUERY
  SELECT
    dp.id AS driver_profile_id,
    ST_Y(dp.current_location::geometry) AS latitude,
    ST_X(dp.current_location::geometry) AS longitude,
    dp.current_heading::DOUBLE PRECISION AS heading,
    v.type::TEXT AS vehicle_type,
    dp.custom_per_km_rate_cup
  FROM driver_profiles dp
  INNER JOIN vehicles v
    ON v.driver_id = dp.id
    AND v.is_active = true
  WHERE dp.is_online = true
    AND dp.status = 'approved'
    AND dp.current_location IS NOT NULL
    AND ST_DWithin(dp.current_location, v_center, p_radius_m)
    AND (p_vehicle_type IS NULL OR v.type::TEXT = p_vehicle_type)
    AND NOT EXISTS (
      SELECT 1 FROM rides r
      WHERE r.driver_id = dp.id
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
    )
  ORDER BY ST_Distance(dp.current_location, v_center)
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION find_nearby_vehicles TO anon, authenticated;

-- 1H. Update complete_ride_and_pay to use exchange rate + TRC
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
  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;
  v_raw_fare := ROUND(
    v_svc.base_fare_cup +
    (v_distance_km * v_svc.per_km_rate_cup) +
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

  -- 9. Insert final pricing snapshot
  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc
  ) VALUES (
    p_ride_id, 'final', v_svc.base_fare_cup, v_svc.per_km_rate_cup,
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
    'surge_multiplier', v_surge
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
