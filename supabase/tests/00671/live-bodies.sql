-- The function bodies 00671 patches, as pg_get_functiondef printed them from prod on 2026-11-02,
-- byte for byte (captured through the Supabase MCP). md5 of prosrc in run.sh (OLD_BODIES).

CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Marketing rides as a passenger: its rights over a ride are a customer's
  -- (or a driver's, below, when it owns the approved driver profile).
  IF v_user_role IN ('marketing', 'operator') THEN
    v_user_role := 'customer';
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();
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
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;

  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    IF OLD.final_fare_cup IS NULL
       AND NEW.final_fare_cup IS NOT NULL
       AND OLD.status IN ('in_progress','arrived_at_destination')
       AND NEW.status = 'completed' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
    END IF;
  END IF;

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method
     AND NOT (OLD.status = 'completed' AND OLD.payment_method = 'tricicoin'
              AND NEW.payment_method = 'mixed'
              AND COALESCE(current_setting('app.ride_payment_to_mixed', true), '') = '1') THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;
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
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;
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
    -- CLI-001: pricing fields used as source of truth by complete_ride_and_pay
    IF NEW.surge_multiplier IS DISTINCT FROM OLD.surge_multiplier
       OR NEW.driver_custom_rate_cup IS DISTINCT FROM OLD.driver_custom_rate_cup
       OR NEW.wallet_ratio IS DISTINCT FROM OLD.wallet_ratio
       OR NEW.insurance_premium_cup IS DISTINCT FROM OLD.insurance_premium_cup
       OR NEW.wait_time_charge_cup IS DISTINCT FROM OLD.wait_time_charge_cup THEN
      RAISE EXCEPTION 'customer cannot modify pricing fields (surge_multiplier, driver_custom_rate_cup, wallet_ratio, insurance_premium_cup, wait_time_charge_cup)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_rides_validate_actuals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_distance_m IS NOT DISTINCT FROM OLD.actual_distance_m
     AND NEW.actual_duration_s IS NOT DISTINCT FROM OLD.actual_duration_s THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_distance_m IS NOT NULL THEN
    IF NEW.actual_distance_m < 0 THEN
      RAISE EXCEPTION 'actual_distance_m cannot be negative (got %)', NEW.actual_distance_m;
    END IF;
    IF NEW.actual_distance_m > 200000 THEN
      RAISE EXCEPTION 'actual_distance_m exceeds 200km absolute limit (got % m)', NEW.actual_distance_m;
    END IF;
    IF OLD.estimated_distance_m IS NOT NULL
       AND OLD.estimated_distance_m > 0
       AND NEW.actual_distance_m > GREATEST(OLD.estimated_distance_m * 2, 5000) THEN
      RAISE WARNING 'actual_distance_m (%) exceeds 2x estimate (% m) for ride %. Flagged for review; completion allowed.',
        NEW.actual_distance_m, OLD.estimated_distance_m, NEW.id;
    END IF;
  END IF;

  IF NEW.actual_duration_s IS NOT NULL THEN
    IF NEW.actual_duration_s < 0 THEN
      RAISE EXCEPTION 'actual_duration_s cannot be negative (got %)', NEW.actual_duration_s;
    END IF;
    IF NEW.actual_duration_s > 28800 THEN
      RAISE EXCEPTION 'actual_duration_s exceeds 8h absolute limit (got % s)', NEW.actual_duration_s;
    END IF;
    IF OLD.estimated_duration_s IS NOT NULL
       AND OLD.estimated_duration_s > 0
       AND NEW.actual_duration_s > GREATEST(OLD.estimated_duration_s * 3, 600) THEN
      RAISE WARNING 'actual_duration_s (%) exceeds 3x estimate (% s) for ride %. Flagged for review; completion allowed.',
        NEW.actual_duration_s, OLD.estimated_duration_s, NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(p_ride_id uuid, p_driver_id uuid, p_actual_distance_m integer, p_actual_duration_s integer)
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
  -- PASO 2: distancia calculada en servidor + auditoría del valor del cliente
  v_server_distance_m INTEGER;
  v_reported_distance_m INTEGER;
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
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

  -- PASO 2: la distancia real sale del rastro GPS del propio viaje.
  -- El valor del cliente queda en reported_distance_m para auditoría.
  -- Fallback al valor del cliente si no hay rastro utilizable (modo no-GPS).
  v_reported_distance_m := p_actual_distance_m;
  v_server_distance_m := compute_ride_trail_distance_m(
    p_ride_id,
    COALESCE(v_ride.pickup_at, v_ride.accepted_at, v_ride.created_at)
  );
  IF v_server_distance_m IS NOT NULL AND v_server_distance_m > 0 THEN
    p_actual_distance_m := v_server_distance_m;
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
    get_weather_surge()
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
  -- commission_rate_zero_guard (00494): 0/NULL/>=1 platform default is invalid -> 15%
  IF v_default_commission_rate IS NULL OR v_default_commission_rate <= 0 OR v_default_commission_rate >= 1 THEN
    v_default_commission_rate := 0.15;
  END IF;
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
    reported_distance_m = v_reported_distance_m,
    -- Backstop: la app actual nunca marca arrived_at_destination, así que la
    -- columna quedaba NULL en viajes completados. Aproximación = completed_at.
    arrived_at_destination_at = COALESCE(arrived_at_destination_at, NOW()),
    excess_distance_uncharged_m = v_excess_m,
    share_token = v_share_token,
    payment_status = v_payment_status
  WHERE id = p_ride_id;

  -- PASO 2: telemetría de discrepancia cliente vs servidor (>25% y >150 m)
  IF v_server_distance_m IS NOT NULL AND v_reported_distance_m IS NOT NULL
     AND abs(v_server_distance_m - v_reported_distance_m) >
         GREATEST(150, ROUND(v_reported_distance_m * 0.25)) THEN
    INSERT INTO validation_events (driver_id, event_type, ride_id, properties)
    VALUES (
      v_driver_user_id,
      'distance_mismatch',
      p_ride_id,
      jsonb_build_object(
        'reported_m', v_reported_distance_m,
        'server_m', v_server_distance_m
      )
    );
  END IF;

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

  -- 00636: a TriciCoin ride whose rider can no longer cover the fare is
  -- completed as a mixed ride: the wallet pays what it holds, the rest is cash.
  IF v_payment_method_text = 'tricicoin' AND NOT COALESCE(v_ride.is_split, false) THEN
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    IF COALESCE(v_customer_balance, 0) < v_final_fare_trc + v_insurance_premium_trc THEN
      v_payment_method_text := 'mixed';
      v_ride.payment_method := 'mixed';
      v_ride.wallet_ratio := 1;
      PERFORM set_config('app.ride_payment_to_mixed', '1', true);
      UPDATE rides SET payment_method = 'mixed', wallet_ratio = 1 WHERE id = p_ride_id;
      PERFORM set_config('app.ride_payment_to_mixed', '', true);
    END IF;
  END IF;

  IF v_payment_method_text = 'tricicoin' THEN
    -- 00340 FIX: driver_cash -> tricicoin
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
        -- 00636: each payer's wallet pays what it holds, up to its share; the rest is cash.
        IF v_split_amount > GREATEST(COALESCE(v_split_balance, 0), 0) THEN
          v_cash_amount := COALESCE(v_cash_amount, 0) + v_split_amount - GREATEST(COALESCE(v_split_balance, 0), 0);
          v_split_amount := GREATEST(COALESCE(v_split_balance, 0), 0);
        END IF;

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
        IF v_requester_amount > GREATEST(COALESCE(v_customer_balance, 0), 0) THEN
          v_cash_amount := COALESCE(v_cash_amount, 0) + v_requester_amount - GREATEST(COALESCE(v_customer_balance, 0), 0);
          v_requester_amount := GREATEST(COALESCE(v_customer_balance, 0), 0);
        END IF;
        IF v_cash_amount > 0 THEN
          v_wallet_amount := v_final_fare_trc - v_cash_amount;
          v_ride.payment_method := 'mixed';
          PERFORM set_config('app.ride_payment_to_mixed', '1', true);
          UPDATE rides SET payment_method = 'mixed',
            wallet_ratio = ROUND(v_wallet_amount::numeric / v_final_fare_trc, 4),
            wallet_amount_cup = v_wallet_amount,
            cash_amount_cup = v_cash_amount
          WHERE id = p_ride_id;
          PERFORM set_config('app.ride_payment_to_mixed', '', true);
        END IF;

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
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings - COALESCE(v_cash_amount, 0), v_driver_balance + v_driver_earnings - COALESCE(v_cash_amount, 0));
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance + v_driver_earnings - COALESCE(v_cash_amount, 0) WHERE id = v_driver_account_id;
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
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings - COALESCE(v_cash_amount, 0), v_driver_balance + v_driver_earnings - COALESCE(v_cash_amount, 0));
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance - v_final_fare_trc WHERE id = v_customer_account_id;
      UPDATE wallet_accounts SET balance = balance + v_driver_earnings - COALESCE(v_cash_amount, 0) WHERE id = v_driver_account_id;
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
    -- 00340 FIX: driver_cash -> tricicoin
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), GREATEST(v_customer_balance - v_insurance_premium_trc, 0));
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

    -- 00340 FIX: credit wallet portion (not full earnings) to tricicoin.
    -- Cash portion off-platform. Net driver in tricicoin: +wallet - commission.
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
      v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
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

  
  -- 00481: promo subsidy — platform absorbs promo discounts, driver made whole.
  DECLARE
    v_promo_disc INTEGER;
    v_gross_no_promo INTEGER;
    v_driver_should INTEGER;
    v_subsidy INTEGER;
    v_subsidy_trc INTEGER;
    v_sub_platform_account UUID;
    v_sub_platform_balance INTEGER;
    v_sub_driver_account UUID;
    v_sub_driver_balance INTEGER;
    v_subsidy_txn UUID;
  BEGIN
    v_promo_disc := GREATEST(
      COALESCE(v_ride.discount_amount_cup, 0) - COALESCE(v_ride.shared_ride_discount_cup, 0), 0);
    IF v_promo_disc > 0 AND (v_ride.promo_code_id IS NOT NULL OR COALESCE(v_ride.partner_discount_cup, 0) > 0) THEN
      v_gross_no_promo := GREATEST(v_fare - COALESCE(v_ride.shared_ride_discount_cup, 0), 0)
                        + COALESCE(v_wait_charge, 0);
      v_driver_should := v_gross_no_promo - ROUND(v_gross_no_promo * v_default_commission_rate);
      v_subsidy := GREATEST(v_driver_should - v_driver_earnings, 0);
      IF v_subsidy > 0 THEN
        v_subsidy_trc := cup_to_trc_centavos(v_subsidy, v_exchange_rate);
        v_sub_driver_account := ensure_wallet_account(v_driver_user_id, 'tricicoin');
        v_sub_platform_account := ensure_wallet_account(v_platform_user_id, 'platform_promotions');
        SELECT balance INTO v_sub_platform_balance
          FROM wallet_accounts WHERE id = v_sub_platform_account FOR UPDATE;
        SELECT balance INTO v_sub_driver_balance
          FROM wallet_accounts WHERE id = v_sub_driver_account FOR UPDATE;
        BEGIN
          INSERT INTO ledger_transactions (
            id, idempotency_key, type, status,
            reference_type, reference_id, description, created_by
          ) VALUES (
            gen_random_uuid(),
            'promo_subsidy:' || p_ride_id::TEXT,
            'promo_credit', 'posted',
            'ride', p_ride_id,
            'Subsidio de promo al conductor - viaje con descuento promocional',
            v_driver_user_id
          )
          RETURNING id INTO v_subsidy_txn;

          INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
          VALUES (v_subsidy_txn, v_sub_platform_account, -v_subsidy_trc, v_sub_platform_balance - v_subsidy_trc);

          INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
          VALUES (v_subsidy_txn, v_sub_driver_account, v_subsidy_trc, v_sub_driver_balance + v_subsidy_trc);

          UPDATE wallet_accounts SET balance = balance - v_subsidy_trc WHERE id = v_sub_platform_account;
          UPDATE wallet_accounts SET balance = balance + v_subsidy_trc WHERE id = v_sub_driver_account;
        EXCEPTION WHEN unique_violation THEN
          NULL; -- subsidy already paid for this ride (idempotent)
        END;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'promo subsidy failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  END;

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
    'reported_distance_m', v_reported_distance_m,
    'server_distance_m', v_server_distance_m,
    'min_fare_used', v_eff_min_fare,
    'corporate_commission_rate_used', v_corp_commission_rate,
    'default_commission_rate_used', v_default_commission_rate
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_offer_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin           uuid := auth.uid();
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_offer           public.ride_offers%ROWTYPE;
  v_expires         timestamptz;
  v_dist            double precision;
  v_mode            text;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;
  -- Not before its time: a driver who accepts a ride hours early is cancelled by
  -- stale_pre_pickup (00282). The predicate of on_ride_insert_dispatch.
  IF COALESCE(v_ride.is_scheduled, false) AND v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'scheduled_at', v_ride.scheduled_at);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT COALESCE((SELECT u.is_active FROM public.users u WHERE u.id = v_dp.user_id), false) THEN
    RETURN jsonb_build_object('error', 'driver_inactive');
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337): the driver could not accept it anyway.
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  v_expires := now() + make_interval(secs => GREATEST(30, public.get_platform_config_numeric('support_offer_ttl_s', 120)::int));
  v_dist := ST_Distance(v_dp.current_location, v_ride.pickup_location);

  SELECT * INTO v_offer FROM public.ride_offers
   WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_profile_id
   FOR UPDATE;

  -- The driver already accepted this ride once (it went back to searching, 00542). Moving that
  -- row off 'accepted' would lower their acceptance_rate for good (00555); "Asignar directo"
  -- gives them the ride instead.
  IF FOUND AND v_offer.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'offer_already_accepted');
  END IF;

  IF v_offer.id IS NULL THEN
    -- trg_notify_driver_new_offer pushes it like any dispatched offer.
    INSERT INTO public.ride_offers (ride_id, driver_profile_id, distance_m, expires_at)
    VALUES (p_ride_id, p_driver_profile_id, v_dist, v_expires);
    v_mode := 'created';
  ELSIF v_offer.status = 'pending' AND v_offer.expires_at > now() THEN
    -- Already on the driver's screen: give it the support TTL, without a second push.
    UPDATE public.ride_offers SET expires_at = GREATEST(expires_at, v_expires) WHERE id = v_offer.id;
    v_mode := 'extended';
  ELSE
    -- Re-armed through 'expired', so trg_notify_driver_reoffer (expired -> pending) pushes it.
    IF v_offer.status <> 'expired' THEN
      UPDATE public.ride_offers SET status = 'expired' WHERE id = v_offer.id;
    END IF;
    UPDATE public.ride_offers
       SET status = 'pending', expires_at = v_expires, distance_m = v_dist, responded_at = NULL
     WHERE id = v_offer.id;
    v_mode := 'rearmed';
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_admin, 'support_offer_ride', 'ride', p_ride_id::text,
          CASE WHEN v_offer.id IS NULL THEN NULL ELSE jsonb_build_object('offer_status', v_offer.status) END,
          jsonb_build_object('driver_profile_id', p_driver_profile_id, 'mode', v_mode, 'expires_at', v_expires));

  RETURN jsonb_build_object('success', true, 'mode', v_mode, 'expires_at', v_expires);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assign_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_active_id       uuid;
  v_afford          jsonb;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
  v_key             text;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;
  -- As for an offer: stale_pre_pickup (00282) would cancel a ride accepted hours early.
  IF COALESCE(v_ride.is_scheduled, false) AND v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'scheduled_at', v_ride.scheduled_at);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT COALESCE((SELECT u.is_active FROM public.users u WHERE u.id = v_dp.user_id), false) THEN
    RETURN jsonb_build_object('error', 'driver_inactive');
  END IF;
  IF NOT v_dp.is_online THEN
    RETURN jsonb_build_object('error', 'not_online');
  END IF;
  IF v_dp.last_heartbeat_at IS NOT NULL AND v_dp.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error', 'stale_heartbeat', 'last_heartbeat_at', v_dp.last_heartbeat_at);
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337).
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  SELECT a.id INTO v_active_id FROM public.rides a
   WHERE a.driver_id = v_dp.id
     AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
     AND a.id <> p_ride_id
   LIMIT 1;
  IF v_active_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'busy', 'active_ride_id', v_active_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = v_ride.service_type AND is_active) THEN
    RETURN jsonb_build_object('error', 'service_config_missing');
  END IF;

  v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    RETURN jsonb_build_object('error', 'insufficient_balance',
      'balance_trc', (v_afford->>'balance_trc')::int, 'required_trc', (v_afford->>'required_trc')::int);
  END IF;

  BEGIN
    UPDATE public.rides
       SET driver_id              = v_dp.id,
           status                 = 'accepted',
           accepted_at            = now(),
           driver_custom_rate_cup = v_dp.custom_per_km_rate_cup
     WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION WHEN unique_violation THEN
    -- rides_one_active_per_driver: the driver took another ride a moment ago.
    RETURN jsonb_build_object('error', 'busy', 'race', true);
  END;

  UPDATE public.ride_offers SET status = 'accepted', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id = v_dp.id AND status = 'pending';
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id <> v_dp.id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_assign_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', 'searching'),
          jsonb_build_object('status', 'accepted', 'driver_profile_id', v_dp.id),
          v_reason);

  -- The driver's push. Category system is always delivered; send-push overwrites data.type with
  -- the category, so the event travels in data.event. Driver apps from 1.7.4 load the trip when
  -- it arrives; older ones load it when the app comes back to the foreground. In a block of its
  -- own, like notify_driver_new_offer: a failing push must not take back the assignment.
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING 'admin_assign_ride_to_driver: no service role key, no push for ride %', p_ride_id;
      PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
        jsonb_build_object('driver_profile_id', v_dp.id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('support-assign-push',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object(
          'user_id', v_dp.user_id::text,
          'title', 'Soporte te asignó un viaje',
          'body', 'Recogida: ' || left(COALESCE(v_ride.pickup_address, '—'), 60)
                  || ' · ' || COALESCE(v_ride.estimated_fare_cup, 0) || ' CUP. Abre la app.',
          'category', 'system',
          'data', jsonb_build_object('event', 'ride_assigned', 'ride_id', p_ride_id::text)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'admin_assign_ride_to_driver: the push for ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
      jsonb_build_object('driver_profile_id', v_dp.id, 'error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'driver_profile_id', v_dp.id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_change_ride_service(p_ride_id uuid, p_service_type text, p_fare_cup integer, p_mode text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin  uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride   public.rides%ROWTYPE;
  v_err    text;
  v_ttl    integer;
  v_prop   public.ride_service_proposals%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('propose', 'apply') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_mode = 'apply' AND v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_err, 'status', v_ride.status);
  END IF;

  IF p_mode = 'propose' THEN
    v_ttl := GREATEST(60, public.get_platform_config_numeric('support_proposal_ttl_s', 180)::int);
    UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
     WHERE ride_id = p_ride_id AND status = 'pending';
    INSERT INTO public.ride_service_proposals
      (ride_id, from_service_type, to_service_type, from_fare_cup, to_fare_cup, proposed_by, expires_at)
    VALUES
      (p_ride_id, v_ride.service_type, p_service_type, COALESCE(v_ride.estimated_fare_cup, 0), p_fare_cup,
       v_admin, now() + make_interval(secs => v_ttl))
    RETURNING * INTO v_prop;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
    VALUES (v_admin, 'support_propose_service', 'ride', p_ride_id::text,
            jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup),
            jsonb_build_object('service_type', p_service_type, 'estimated_fare_cup', p_fare_cup, 'proposal_id', v_prop.id),
            v_reason);
    RETURN jsonb_build_object('success', true, 'mode', 'propose',
                              'proposal_id', v_prop.id, 'expires_at', v_prop.expires_at);
  END IF;

  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  SELECT v_admin, 'support_change_service', 'ride', p_ride_id::text,
         jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup,
                            'discount_amount_cup', v_ride.discount_amount_cup),
         jsonb_build_object('service_type', r.service_type, 'estimated_fare_cup', r.estimated_fare_cup,
                            'discount_amount_cup', r.discount_amount_cup),
         v_reason
  FROM public.rides r WHERE r.id = p_ride_id;
  RETURN jsonb_build_object('success', true, 'mode', 'apply');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_release_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_reopened integer;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The driver first, then the ride: the order of release_rides_from_dead_drivers
  -- (block A) and update_driver_position, so a release never deadlocks with them.
  -- NO KEY UPDATE is the lock the UPDATE below needs (it touches no key) and the
  -- one block A's own UPDATE of the driver takes, so they queue behind each other
  -- the same way. FOR UPDATE would also hold back the foreign-key checks of rows
  -- that reference this driver.
  PERFORM 1 FROM public.driver_profiles WHERE id = p_expected_driver_id FOR NO KEY UPDATE;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('accepted', 'driver_en_route') THEN
    RETURN jsonb_build_object('error', 'ride_not_releasable', 'status', v_ride.status);
  END IF;
  IF v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  -- He reconnects by hand (the push tells him). No auto_offline_at: the
  -- trigger tg_driver_profiles_shift_intent clears it on any is_online change a
  -- person makes, an admin included.
  UPDATE public.driver_profiles SET is_online = false WHERE id = v_ride.driver_id AND is_online;

  UPDATE public.rides SET
    status = 'searching', driver_id = NULL, accepted_at = NULL,
    searching_seen_at = now(), last_dispatched_at = NULL,
    driver_gps_status = 'healthy', driver_gps_unavailable_at = NULL,
    gps_override_requested_at = NULL, gps_override_confirmed_at = NULL,
    gps_check_distance_m = NULL, driver_custom_rate_cup = NULL,
    proximity_pickup_notified_at = NULL,
    updated_at = now()
  WHERE id = p_ride_id;

  -- The driver's accepted offer stays 'accepted': dispatch never re-offers it,
  -- and the driver's acceptance_rate does not move.
  UPDATE public.ride_offers SET status = 'expired'
   WHERE ride_id = p_ride_id AND driver_profile_id = v_ride.driver_id AND status = 'pending';
  v_reopened := public._reopen_ride_offers(p_ride_id, v_ride.driver_id);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.ride_assist AS ra (ride_id, wait_alert_sent_at, wait_email_sent_at)
  VALUES (p_ride_id, now(), now())
  ON CONFLICT (ride_id) DO UPDATE SET
    wait_alert_sent_at = COALESCE(ra.wait_alert_sent_at, now()),
    wait_email_sent_at = COALESCE(ra.wait_email_sent_at, now());

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_release_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_profile_id', v_ride.driver_id),
          jsonb_build_object('status', 'searching', 'offers_reopened', v_reopened), v_reason);

  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_ride.customer_id,
    'Buscando otro conductor',
    'Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo.',
    'ride', jsonb_build_object('reason', 'support_ride_released'));
  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_driver_user,
    'Soporte te quitó el viaje',
    'Estamos buscando otro conductor para este viaje. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes.',
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'release'));

  BEGIN
    PERFORM public.dispatch_ride(p_ride_id);
  EXCEPTION WHEN OTHERS THEN
    -- The release stands; retry_dispatch_expired_rides picks it up next minute.
    RAISE WARNING 'admin_release_active_ride: dispatch of ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_release_active_ride', v_admin, p_ride_id, 'dispatch_failed',
      jsonb_build_object('error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', 'searching');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_advance_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_new public.rides%ROWTYPE;
  v_driver_user uuid;
  v_to public.ride_status;
  v_body text;
  v_w record;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status IN ('accepted', 'driver_en_route') AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  IF v_ride.status IN ('accepted', 'driver_en_route') THEN
    v_to := 'arrived_at_pickup';
    v_body := 'Marcamos que llegaste al punto de recogida.';
    UPDATE public.rides
       SET status = v_to, driver_arrived_at = COALESCE(driver_arrived_at, now()), updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'arrived_at_pickup' THEN
    v_to := 'in_progress';
    v_body := 'Marcamos el viaje como iniciado.';
    UPDATE public.rides
       SET status = v_to,
           pickup_at = COALESCE(v_ride.pickup_at,
                                public._ride_gps_departure_at(p_ride_id, v_ride.driver_arrived_at),
                                v_ride.driver_arrived_at, now()),
           updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'in_progress' THEN
    -- The driver's app asks for a cargo ride's delivery proof (the recipient's
    -- code and the photo) only while it is in_progress: moved to the destination
    -- without it, the ride could no longer be completed.
    IF COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
         SELECT 1 FROM public.delivery_details dd
         WHERE dd.ride_id = p_ride_id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL) THEN
      RETURN jsonb_build_object('error', 'delivery_proof_missing', 'status', v_ride.status);
    END IF;
    v_to := 'arrived_at_destination';
    v_body := 'Marcamos que llegaste al destino.';
    UPDATE public.rides SET status = v_to, updated_at = now() WHERE id = p_ride_id;
  ELSE
    RETURN jsonb_build_object('error', 'ride_not_advanceable', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_new FROM public.rides WHERE id = p_ride_id;
  -- The wait these times give (0 before pickup): what completion will charge.
  SELECT * INTO v_w FROM public._wait_charge_for(v_new.service_type, v_new.driver_arrived_at, v_new.pickup_at);

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_advance_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at),
          jsonb_build_object('status', v_to, 'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
                             'wait_minutes', v_w.wait_minutes, 'wait_cup', v_w.charge),
          v_reason);

  -- The rider already gets the status push from notify_ride_status_change.
  PERFORM public._support_ride_push('admin_advance_active_ride', p_ride_id, v_driver_user,
    'Soporte actualizó tu viaje', v_body,
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'advance', 'status', v_to));

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_to,
    'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
    'wait_minutes', v_w.wait_minutes, 'billable_minutes', v_w.billable_minutes, 'wait_cup', v_w.charge);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_complete_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_expected_total_cup integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_preview jsonb;
  v_status text;
  v_final integer;
  v_method text;
  v_row_cash integer;
  v_cash integer;
  v_wallet integer;
  v_pay jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RETURN jsonb_build_object('error', 'ride_not_completable', 'status', v_ride.status);
  END IF;
  -- tg_rides_require_delivery_proof lets admins through, so the proof a cargo
  -- ride needs (the recipient's code and the delivery photo) is checked here.
  IF COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
       SELECT 1 FROM public.delivery_details dd
       WHERE dd.ride_id = p_ride_id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL) THEN
    RETURN jsonb_build_object('error', 'delivery_proof_missing', 'status', v_ride.status);
  END IF;
  v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  IF v_preview IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agreed_price', 'status', v_ride.status);
  END IF;
  IF (v_preview->>'total_cup')::integer IS DISTINCT FROM p_expected_total_cup THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'status', v_ride.status,
                              'total_cup', (v_preview->>'total_cup')::integer);
  END IF;

  -- The distance does not change a ride with a snapshot: complete_ride_and_pay
  -- prefers the trail distance and only records it.
  PERFORM public.complete_ride_and_pay(p_ride_id, v_ride.driver_id,
                                       v_ride.estimated_distance_m, v_ride.estimated_duration_s);
  SELECT status::text, final_fare_cup, payment_method::text, COALESCE(cash_amount_cup, 0)
    INTO v_status, v_final, v_method, v_row_cash
  FROM public.rides WHERE id = p_ride_id;
  -- What support tells a driver whose app is down: how much to collect in cash.
  -- Derived from the ride row, not read from complete_ride_and_pay's result: its
  -- cash_amount_cup and wallet_amount_cup are 0 on a cash ride (it fills them
  -- only for a mixed ride, a split and the wallet shortfall of 00637, which turns
  -- the ride into a mixed one), yet the driver collects the whole fare. In the
  -- response, cash_amount_cup is the cash the driver collects and
  -- wallet_amount_cup what the wallets paid. The result is not read at all: a
  -- cast error here would roll back a payment that went through.
  v_cash := CASE v_method WHEN 'cash' THEN v_final WHEN 'mixed' THEN v_row_cash ELSE 0 END;
  v_wallet := CASE WHEN v_method IN ('tricicoin', 'mixed') THEN GREATEST(v_final - v_cash, 0) ELSE 0 END;
  v_pay := jsonb_build_object('final_fare_cup', v_final, 'payment_method', v_method,
                              'cash_amount_cup', v_cash, 'wallet_amount_cup', v_wallet);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_complete_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status),
          jsonb_build_object('status', v_status, 'preview', v_preview) || v_pay,
          v_reason);

  -- No support push: notify_ride_status_change already pushes both on 'completed'.
  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_status) || v_pay;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_cancel_ride(p_ride_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_ride  rides%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  IF v_ride.status IN ('completed', 'canceled') THEN
    RETURN jsonb_build_object('error', 'ride_already_closed', 'status', v_ride.status);
  END IF;

  UPDATE rides SET
    status              = 'canceled',
    canceled_at         = now(),
    canceled_by         = v_admin,
    cancellation_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'admin_cancel')
  WHERE id = p_ride_id;

  UPDATE ride_offers SET status = 'superseded', responded_at = now()
  WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (
    v_admin, 'cancel_ride', 'ride', p_ride_id::text,
    jsonb_build_object('status', v_ride.status),
    jsonb_build_object('status', 'canceled'),
    p_reason
  );

  RETURN jsonb_build_object(
    'success',         true,
    'ride_id',         p_ride_id,
    'previous_status', v_ride.status
  );
END;
$function$
;
