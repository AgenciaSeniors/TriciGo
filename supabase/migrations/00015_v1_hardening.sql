-- ============================================================
-- Migration 00015: V1 Hardening
-- Fixes 6 bugs found in production readiness audit:
--   1. find_best_drivers: v.service_type → v.type
--   2. Cancellation score trigger: UUID type mismatch
--   3. get_wallet_summary: hardcoded zeros for totals
--   4. Add maybe_promote_user_level trigger
--   5. Add support tables to realtime publication
--   6. Fix surge multiplier in complete_ride_and_pay
-- ============================================================

-- ============================================================
-- 1. Fix find_best_drivers: vehicles.type, not vehicles.service_type
-- ============================================================
CREATE OR REPLACE FUNCTION find_best_drivers(
  p_pickup_lat DOUBLE PRECISION,
  p_pickup_lng DOUBLE PRECISION,
  p_service_type TEXT,
  p_limit INTEGER DEFAULT 5,
  p_radius_m INTEGER DEFAULT 5000
) RETURNS TABLE (
  driver_id UUID,
  user_id UUID,
  distance_m DOUBLE PRECISION,
  match_score DECIMAL,
  rating_avg DECIMAL,
  acceptance_rate DECIMAL,
  composite_score DOUBLE PRECISION
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_pickup GEOGRAPHY;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id AS dp_id,
      dp.user_id AS dp_user_id,
      dp.match_score AS dp_match_score,
      dp.rating_avg AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND dp.match_score > 10
      AND v.type = p_service_type          -- FIX: was v.service_type
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.user_id
          AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
      )
  )
  SELECT
    ed.dp_id,
    ed.dp_user_id,
    ed.dist_m,
    ed.dp_match_score,
    ed.dp_rating,
    ed.dp_acceptance,
    (
      0.4 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
      0.3 * (ed.dp_match_score / 100.0) +
      0.2 * (ed.dp_rating / 5.0) +
      0.1 * (ed.dp_acceptance / 100.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT p_limit;
END;
$$;

-- ============================================================
-- 2. Fix cancellation score trigger: compare canceled_by (user UUID)
--    with driver_profiles.user_id instead of rides.driver_id (profile UUID)
-- ============================================================
CREATE OR REPLACE FUNCTION trg_ride_canceled_score()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'canceled' AND OLD.status != 'canceled'
     AND NEW.driver_id IS NOT NULL
     AND NEW.canceled_by IS NOT NULL
     AND NEW.canceled_by = (
       SELECT dp.user_id FROM driver_profiles dp WHERE dp.id = NEW.driver_id
     )
  THEN
    PERFORM update_driver_score(NEW.driver_id, 'cancel_by_driver',
      jsonb_build_object('ride_id', NEW.id));
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. Fix get_wallet_summary: compute total_earned / total_spent from ledger
-- ============================================================
CREATE OR REPLACE FUNCTION get_wallet_summary(p_user_id UUID)
RETURNS TABLE(
  available_balance INTEGER,
  held_balance INTEGER,
  total_earned INTEGER,
  total_spent INTEGER,
  currency TEXT
) AS $$
DECLARE
  v_account_ids UUID[];
  v_earned INTEGER;
  v_spent INTEGER;
BEGIN
  -- Collect all wallet account IDs for this user
  SELECT ARRAY_AGG(wa.id) INTO v_account_ids
  FROM wallet_accounts wa
  WHERE wa.user_id = p_user_id;

  -- Compute totals from ledger entries
  IF v_account_ids IS NOT NULL AND array_length(v_account_ids, 1) > 0 THEN
    SELECT
      COALESCE(SUM(CASE WHEN le.amount > 0 THEN le.amount ELSE 0 END), 0)::INTEGER,
      COALESCE(ABS(SUM(CASE WHEN le.amount < 0 THEN le.amount ELSE 0 END)), 0)::INTEGER
    INTO v_earned, v_spent
    FROM ledger_entries le
    WHERE le.account_id = ANY(v_account_ids);
  ELSE
    v_earned := 0;
    v_spent := 0;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(wa.balance, 0)::INTEGER AS available_balance,
    COALESCE(wa.held_balance, 0)::INTEGER AS held_balance,
    v_earned AS total_earned,
    v_spent AS total_spent,
    'TRC'::TEXT AS currency
  FROM wallet_accounts wa
  WHERE wa.user_id = p_user_id
    AND wa.account_type = 'customer_cash'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::INTEGER, 0::INTEGER, v_earned, v_spent, 'TRC'::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- 4. Trigger: promote user level after ride completion
-- ============================================================
CREATE OR REPLACE FUNCTION trg_maybe_promote_on_complete()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed'
     AND NEW.customer_id IS NOT NULL THEN
    PERFORM maybe_promote_user_level(NEW.customer_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_maybe_promote_on_complete ON rides;
CREATE TRIGGER trg_maybe_promote_on_complete
  AFTER UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status != 'completed')
  EXECUTE FUNCTION trg_maybe_promote_on_complete();

-- ============================================================
-- 5. Add support tables to realtime publication
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE support_tickets;
ALTER PUBLICATION supabase_realtime ADD TABLE ticket_messages;

-- ============================================================
-- 6. Fix complete_ride_and_pay: use calculate_surge for surge_multiplier
--    instead of hardcoded 1.00
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

  -- 3. Calculate final fare (with surge)
  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;
  v_raw_fare := ROUND(
    v_svc.base_fare_cup +
    (v_distance_km * v_svc.per_km_rate_cup) +
    (v_duration_min * v_svc.per_minute_rate_cup)
  );
  v_fare := GREATEST(ROUND(v_raw_fare * v_surge), v_svc.min_fare_cup);
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

  -- 7. Insert final pricing snapshot (with actual surge multiplier)
  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id
  ) VALUES (
    p_ride_id, 'final', v_svc.base_fare_cup, v_svc.per_km_rate_cup,
    v_svc.per_minute_rate_cup, p_actual_distance_m, p_actual_duration_s,
    v_surge, v_fare, v_commission_rate, v_commission_amount, v_final_fare, NULL
  );

  -- 8. Process payment
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
    VALUES (v_txn_id, v_customer_account_id, -v_final_fare, v_customer_balance - v_final_fare);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_final_fare WHERE id = v_customer_account_id;
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
    'share_token', v_share_token,
    'surge_multiplier', v_surge
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
