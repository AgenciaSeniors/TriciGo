-- ============================================================
-- Migration 00121: cancel_ride RPC + cancellation fee restoration
--
-- Two problems solved in one migration:
--
-- 1) apply_cancellation_fee / calculate_cancellation_fee were defined
--    in 00050/00051 but are MISSING from the live DB (a later migration
--    dropped them without replacement). ride.service.ts still calls
--    them — all calls silently fail under try/catch. No rider has
--    been charged a cancel fee. Re-create them with SET search_path
--    hardening.
--
-- 2) Cancellation today happens via direct UPDATE from the client with
--    client-supplied `p_canceled_by`. A rider can spoof `p_canceled_by`
--    to attribute cancellation to the driver (making it free). Replace
--    with `cancel_ride` RPC that derives canceled_by from auth.uid().
-- ============================================================

-- ---- 1. calculate_cancellation_fee (restored from 00051 with hardening) ----
CREATE OR REPLACE FUNCTION public.calculate_cancellation_fee(
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
SET search_path = public, pg_catalog
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
  SELECT r.*, r.status AS ride_status INTO v_ride FROM rides r WHERE r.id = p_ride_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 'ride_not_found'::TEXT, true; RETURN;
  END IF;

  IF v_ride.ride_status = 'searching' THEN
    RETURN QUERY SELECT 0, 0, 'no_driver_assigned'::TEXT, true; RETURN;
  END IF;

  IF v_ride.driver_id IS NOT NULL AND p_canceled_by = (
    SELECT user_id FROM driver_profiles WHERE id = v_ride.driver_id
  ) THEN
    RETURN QUERY SELECT 0, 0, 'driver_canceled'::TEXT, true; RETURN;
  END IF;

  SELECT * INTO v_config FROM cancellation_fee_configs
   WHERE service_type = v_ride.service_type AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 'no_fee_config'::TEXT, true; RETURN;
  END IF;

  IF v_ride.accepted_at IS NOT NULL THEN
    v_seconds_since_accept := EXTRACT(EPOCH FROM (NOW() - v_ride.accepted_at))::INTEGER;
    IF v_seconds_since_accept <= v_config.free_cancel_window_s THEN
      RETURN QUERY SELECT 0, 0, 'within_free_window'::TEXT, true; RETURN;
    END IF;
  END IF;

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

  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, 520);
  IF v_fee_cup > 0 AND v_exchange_rate > 0 THEN
    v_fee_trc := ROUND((v_fee_cup::NUMERIC / v_exchange_rate) * 100);
  END IF;

  RETURN QUERY SELECT v_fee_cup, v_fee_trc, v_reason, (v_fee_cup = 0);
END;
$$;

-- ---- 2. apply_cancellation_fee (restored, with hardening) ----
CREATE OR REPLACE FUNCTION public.apply_cancellation_fee(
  p_ride_id UUID,
  p_canceled_by UUID
)
RETURNS TABLE(
  fee_cup INTEGER,
  fee_trc INTEGER,
  fee_reason TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fee RECORD;
  v_account_id UUID;
  v_current_balance INTEGER;
  v_driver_id UUID;
BEGIN
  SELECT * INTO v_fee FROM calculate_cancellation_fee(p_ride_id, p_canceled_by);

  UPDATE rides
    SET cancellation_fee_cup = v_fee.fee_cup,
        cancellation_fee_trc = v_fee.fee_trc
  WHERE id = p_ride_id;

  IF v_fee.fee_cup > 0 THEN
    -- Debit customer wallet
    SELECT id, balance INTO v_account_id, v_current_balance
    FROM wallet_accounts
    WHERE user_id = p_canceled_by AND account_type = 'customer_cash'
    FOR UPDATE;

    IF v_account_id IS NOT NULL THEN
      WITH txn AS (
        INSERT INTO ledger_transactions (
          idempotency_key, type, status, reference_type, reference_id,
          description, created_by
        ) VALUES (
          'cancel_fee:' || p_ride_id || ':' || p_canceled_by,
          'adjustment', 'posted', 'cancellation_fee', p_ride_id,
          'Tarifa de cancelacion - ' || v_fee.fee_reason, p_canceled_by
        ) RETURNING id
      )
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      SELECT txn.id, v_account_id, -v_fee.fee_trc, v_current_balance - v_fee.fee_trc
      FROM txn;

      UPDATE wallet_accounts SET balance = v_current_balance - v_fee.fee_trc
      WHERE id = v_account_id;
    END IF;

    -- Credit driver wallet
    SELECT r.driver_id INTO v_driver_id FROM rides r WHERE r.id = p_ride_id;
    IF v_driver_id IS NOT NULL THEN
      SELECT wa.id, wa.balance INTO v_account_id, v_current_balance
      FROM wallet_accounts wa
      JOIN driver_profiles dp ON dp.user_id = wa.user_id
      WHERE dp.id = v_driver_id AND wa.account_type = 'driver_cash'
      FOR UPDATE;

      IF v_account_id IS NOT NULL THEN
        WITH txn AS (
          INSERT INTO ledger_transactions (
            idempotency_key, type, status, reference_type, reference_id,
            description, created_by
          ) VALUES (
            'cancel_fee_driver:' || p_ride_id,
            'adjustment', 'posted', 'cancellation_fee', p_ride_id,
            'Compensacion por cancelacion del pasajero', p_canceled_by
          ) RETURNING id
        )
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        SELECT txn.id, v_account_id, v_fee.fee_trc, v_current_balance + v_fee.fee_trc
        FROM txn;

        UPDATE wallet_accounts SET balance = v_current_balance + v_fee.fee_trc
        WHERE id = v_account_id;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT v_fee.fee_cup, v_fee.fee_trc, v_fee.fee_reason;
END;
$$;

-- ---- 3. cancel_ride RPC (new) ----
CREATE OR REPLACE FUNCTION public.cancel_ride(
  p_ride_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_uid      uuid;
  v_ride            rides%ROWTYPE;
  v_is_customer     boolean := false;
  v_is_driver       boolean := false;
  v_canceled_by     uuid;
  v_fee             RECORD;
  v_penalty_amount  integer := 0;
  v_is_blocked      boolean := false;
  v_penalty         RECORD;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.status IN ('completed','canceled') THEN
    RETURN jsonb_build_object('error','ride_already_closed','status',v_ride.status);
  END IF;

  v_is_customer := (v_ride.customer_id = v_caller_uid);
  IF v_ride.driver_id IS NOT NULL THEN
    v_is_driver := EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE id = v_ride.driver_id AND user_id = v_caller_uid
    );
  END IF;

  IF NOT v_is_customer AND NOT v_is_driver THEN
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  -- Server-derived canceled_by: rider → customer_id, driver → user_id of the driver_profile
  v_canceled_by := v_caller_uid;

  UPDATE rides SET
    status = 'canceled',
    canceled_at = now(),
    canceled_by = v_canceled_by,
    cancellation_reason = COALESCE(p_reason, cancellation_reason)
  WHERE id = p_ride_id;

  -- Supersede any pending offers for this ride
  UPDATE ride_offers
    SET status = 'superseded', responded_at = now()
  WHERE ride_id = p_ride_id AND status = 'pending';

  -- Apply state-based fee (no-op if no driver or within free window)
  BEGIN
    SELECT * INTO v_fee FROM apply_cancellation_fee(p_ride_id, v_canceled_by);
  EXCEPTION WHEN OTHERS THEN
    v_fee := NULL;
  END;

  -- Progressive penalty (frequent canceler lockout)
  BEGIN
    SELECT * INTO v_penalty FROM apply_cancellation_penalty(v_canceled_by, p_ride_id);
    v_penalty_amount := COALESCE(v_penalty.penalty_amount, 0);
    v_is_blocked := COALESCE(v_penalty.is_blocked, false);
  EXCEPTION WHEN OTHERS THEN
    v_penalty_amount := 0;
    v_is_blocked := false;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'canceled_by', v_canceled_by,
    'canceled_role', CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
    'fee_cup', COALESCE(v_fee.fee_cup, 0),
    'fee_trc', COALESCE(v_fee.fee_trc, 0),
    'fee_reason', COALESCE(v_fee.fee_reason, 'free_cancel'),
    'penalty_amount', v_penalty_amount,
    'is_blocked', v_is_blocked
  );
END;
$$;

-- ---- 4. Column-level UPDATE guard on rides ----
-- RLS can't express "allowed columns"; use a BEFORE UPDATE trigger.
CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();

  -- Internal (trigger/RPC) calls run as postgres with auth.uid() NULL → allow
  IF v_caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_admin() INTO v_is_admin;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  v_is_customer := (OLD.customer_id = v_caller_uid);
  v_is_driver := (OLD.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = OLD.driver_id AND user_id = v_caller_uid
  ));

  -- Columns that NO client may mutate directly (only via SECURITY DEFINER RPC)
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;
  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
  END IF;
  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
  END IF;
  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;

  -- Driver can't mutate fields they shouldn't own
  IF v_is_driver AND NOT v_is_customer THEN
    IF NEW.estimated_fare_cup IS DISTINCT FROM OLD.estimated_fare_cup
       OR NEW.estimated_fare_trc IS DISTINCT FROM OLD.estimated_fare_trc
       OR NEW.estimated_distance_m IS DISTINCT FROM OLD.estimated_distance_m
       OR NEW.estimated_duration_s IS DISTINCT FROM OLD.estimated_duration_s THEN
      RAISE EXCEPTION 'driver cannot modify ride estimates';
    END IF;
    IF NEW.pickup_location::text IS DISTINCT FROM OLD.pickup_location::text
       OR NEW.dropoff_location::text IS DISTINCT FROM OLD.dropoff_location::text
       OR NEW.pickup_address IS DISTINCT FROM OLD.pickup_address
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;

  -- Customer can't mutate fields reserved for driver/state-machine
  IF v_is_customer AND NOT v_is_driver THEN
    IF NEW.driver_arrived_at IS DISTINCT FROM OLD.driver_arrived_at
       OR NEW.pickup_at IS DISTINCT FROM OLD.pickup_at
       OR NEW.arrived_at_destination_at IS DISTINCT FROM OLD.arrived_at_destination_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'customer cannot modify driver timestamps';
    END IF;
    IF NEW.actual_distance_m IS DISTINCT FROM OLD.actual_distance_m
       OR NEW.actual_duration_s IS DISTINCT FROM OLD.actual_duration_s THEN
      RAISE EXCEPTION 'customer cannot modify actuals';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_ride_update_columns ON rides;
CREATE TRIGGER trg_enforce_ride_update_columns
BEFORE UPDATE ON rides
FOR EACH ROW
EXECUTE FUNCTION enforce_ride_update_columns();
