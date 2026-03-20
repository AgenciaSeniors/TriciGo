-- ============================================================
-- Migration 00051: Fix Cancellation Fee Bugs
-- Fixes:
-- 1. Wrong service_type slugs in cancellation_fee_configs (C3)
-- 2. Undefined variable v_canceled_by → p_canceled_by (C4)
-- 3. Missing FOR UPDATE on wallet balance reads (H8)
-- 4. Inconsistent exchange rate fallback 300 → 520 (M11)
-- ============================================================

-- Fix 1: Delete wrong slugs and insert correct ones
DELETE FROM cancellation_fee_configs
WHERE service_type IN ('triciclo', 'moto', 'auto', 'delivery');

INSERT INTO cancellation_fee_configs (service_type, free_cancel_window_s, en_route_fee_cup, arrived_fee_cup)
VALUES
  ('triciclo_basico', 120, 5000, 10000),
  ('triciclo_premium', 120, 5000, 10000),
  ('moto_standard', 120, 5000, 10000),
  ('auto_standard', 120, 7500, 15000),
  ('mensajeria', 180, 5000, 10000)
ON CONFLICT (service_type) DO NOTHING;

-- Fix 2 + Fix 4: Recreate calculate_cancellation_fee with correct variable name and fallback
CREATE OR REPLACE FUNCTION calculate_cancellation_fee(
  p_ride_id UUID,
  p_canceled_by UUID
)
RETURNS TABLE(
  fee_cup INTEGER,
  fee_trc INTEGER,
  fee_reason TEXT,
  is_free BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_ride RECORD;
  v_config RECORD;
  v_fee_cup INTEGER := 0;
  v_fee_trc INTEGER := 0;
  v_reason TEXT := 'free_cancel';
  v_seconds_since_accept INTEGER;
  v_exchange_rate NUMERIC;
BEGIN
  -- Get ride details
  SELECT r.*, r.status AS ride_status
  INTO v_ride
  FROM rides r
  WHERE r.id = p_ride_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 'ride_not_found'::TEXT, true;
    RETURN;
  END IF;

  -- No fee for rides still searching (no driver assigned)
  IF v_ride.ride_status = 'searching' THEN
    RETURN QUERY SELECT 0, 0, 'no_driver_assigned'::TEXT, true;
    RETURN;
  END IF;

  -- No fee if the driver is canceling (fix: use p_canceled_by, not v_canceled_by)
  IF v_ride.driver_id IS NOT NULL AND p_canceled_by = (
    SELECT user_id FROM driver_profiles WHERE id = v_ride.driver_id
  ) THEN
    RETURN QUERY SELECT 0, 0, 'driver_canceled'::TEXT, true;
    RETURN;
  END IF;

  -- Get fee config for this service type
  SELECT * INTO v_config
  FROM cancellation_fee_configs
  WHERE service_type = v_ride.service_type
    AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 'no_fee_config'::TEXT, true;
    RETURN;
  END IF;

  -- Check free cancellation window
  IF v_ride.accepted_at IS NOT NULL THEN
    v_seconds_since_accept := EXTRACT(EPOCH FROM (NOW() - v_ride.accepted_at))::INTEGER;
    IF v_seconds_since_accept <= v_config.free_cancel_window_s THEN
      RETURN QUERY SELECT 0, 0, 'within_free_window'::TEXT, true;
      RETURN;
    END IF;
  END IF;

  -- Calculate fee based on ride status
  CASE v_ride.ride_status
    WHEN 'accepted', 'driver_en_route' THEN
      v_fee_cup := v_config.en_route_fee_cup;
      v_reason := 'driver_en_route';
    WHEN 'arrived_at_pickup' THEN
      v_fee_cup := v_config.arrived_fee_cup;
      v_reason := 'driver_arrived';
    WHEN 'in_progress' THEN
      v_fee_cup := GREATEST(
        (v_ride.estimated_fare_cup * v_config.in_progress_fee_pct)::INTEGER,
        v_config.in_progress_min_fee_cup
      );
      v_reason := 'ride_in_progress';
    ELSE
      v_fee_cup := 0;
      v_reason := 'free_cancel';
  END CASE;

  -- Convert to TRC if exchange rate available (fix: fallback 520 to match codebase)
  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, 520);
  IF v_fee_cup > 0 AND v_exchange_rate > 0 THEN
    -- 1 TRC = 1 USD, stored in centavos (x100)
    v_fee_trc := ROUND((v_fee_cup::NUMERIC / v_exchange_rate) * 100);
  END IF;

  RETURN QUERY SELECT v_fee_cup, v_fee_trc, v_reason, (v_fee_cup = 0);
END;
$$;

-- Fix 3: Recreate apply_cancellation_fee with FOR UPDATE on wallet reads
CREATE OR REPLACE FUNCTION apply_cancellation_fee(
  p_ride_id UUID,
  p_canceled_by UUID
)
RETURNS TABLE(
  fee_cup INTEGER,
  fee_trc INTEGER,
  fee_reason TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_fee RECORD;
  v_account_id UUID;
  v_current_balance INTEGER;
  v_ride RECORD;
BEGIN
  -- Calculate the fee
  SELECT * INTO v_fee
  FROM calculate_cancellation_fee(p_ride_id, p_canceled_by);

  -- Update ride with cancellation fee
  UPDATE rides
  SET cancellation_fee_cup = v_fee.fee_cup,
      cancellation_fee_trc = v_fee.fee_trc
  WHERE id = p_ride_id;

  -- If fee > 0, charge the customer's wallet
  IF v_fee.fee_cup > 0 THEN
    -- Lock the customer wallet row to prevent concurrent balance updates
    SELECT id, balance INTO v_account_id, v_current_balance
    FROM wallet_accounts
    WHERE user_id = p_canceled_by
      AND account_type = 'customer_cash'
    FOR UPDATE;

    IF v_account_id IS NOT NULL THEN
      -- Create ledger transaction for cancellation fee
      WITH txn AS (
        INSERT INTO ledger_transactions (
          idempotency_key, type, status, reference_type, reference_id,
          description, created_by
        ) VALUES (
          'cancel_fee:' || p_ride_id || ':' || p_canceled_by,
          'adjustment',
          'posted',
          'cancellation_fee',
          p_ride_id,
          'Tarifa de cancelacion - ' || v_fee.fee_reason,
          p_canceled_by
        ) RETURNING id
      )
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      SELECT txn.id, v_account_id, -v_fee.fee_trc, v_current_balance - v_fee.fee_trc
      FROM txn;

      -- Update wallet balance (row already locked by FOR UPDATE)
      UPDATE wallet_accounts
      SET balance = v_current_balance - v_fee.fee_trc
      WHERE id = v_account_id;
    END IF;

    -- Also compensate the driver (partial earnings for their time/gas)
    SELECT r.driver_id INTO v_ride FROM rides r WHERE r.id = p_ride_id;
    IF v_ride.driver_id IS NOT NULL THEN
      -- Lock the driver wallet row
      SELECT wa.id, wa.balance INTO v_account_id, v_current_balance
      FROM wallet_accounts wa
      JOIN driver_profiles dp ON dp.user_id = wa.user_id
      WHERE dp.id = v_ride.driver_id
        AND wa.account_type = 'driver_cash'
      FOR UPDATE;

      IF v_account_id IS NOT NULL THEN
        WITH txn AS (
          INSERT INTO ledger_transactions (
            idempotency_key, type, status, reference_type, reference_id,
            description, created_by
          ) VALUES (
            'cancel_fee_driver:' || p_ride_id,
            'adjustment',
            'posted',
            'cancellation_fee',
            p_ride_id,
            'Compensacion por cancelacion del pasajero',
            p_canceled_by
          ) RETURNING id
        )
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        SELECT txn.id, v_account_id, v_fee.fee_trc, v_current_balance + v_fee.fee_trc
        FROM txn;

        UPDATE wallet_accounts
        SET balance = v_current_balance + v_fee.fee_trc
        WHERE id = v_account_id;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_fee.fee_cup, v_fee.fee_trc, v_fee.fee_reason;
END;
$$;
