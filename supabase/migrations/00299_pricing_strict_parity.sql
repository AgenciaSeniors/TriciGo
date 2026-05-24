-- ============================================================
-- Migration 00299: Pricing strict parity — estimate↔final guarantee
--
-- Cierra el bug BUG-pricing-parity reportado por el usuario:
--
--   Cliente vio "Triciclo $3000" en search → al completar el viaje se
--   cobraron 1440 CUP. Cliente pierde la confianza en el precio
--   mostrado. Verificado con SQL en prod: el ride más reciente
--   (be1b9a37) NO tiene snapshot `estimate` (solo `final`), entonces
--   complete_ride_and_pay recalcula con service_type_configs LIVE.
--   Y accept_ride_v2 ANTES sobrescribía estimated_fare_cup con su
--   propio cálculo sin el experiment multiplier que el cliente vio.
--
-- Decisión del usuario: PARIDAD ESTRICTA. El precio que el cliente ve
-- al pedir es exactamente lo que se cobra al completar, sin importar
-- distancia/tiempo real. Wait_charge se suma aparte cuando aplica.
--
-- ── 3 cambios coordinados en una sola migración ──
--
-- 1) Extender `ride_pricing_snapshots` con 3 cols nullable (idéntico al
--    schema que esperaba la migración 00283 que nunca se aplicó):
--    `min_fare`, `corporate_commission_rate`, `default_commission_rate_snapshot`.
--
-- 2) Trigger `AFTER INSERT ON rides` que persiste automáticamente el
--    snapshot `estimate` desde los datos del INSERT + lookups live a
--    service_type_configs / platform_config / corporate_accounts. El
--    snapshot captura el contrato del precio al momento de pedir el
--    viaje. Ese row es inmutable y es la fuente de verdad downstream.
--
-- 3) `accept_ride_v2`: elimina el bloque de recálculo de fare. NO toca
--    `estimated_fare_cup` ni `estimated_fare_trc` en el UPDATE rides.
--    El gating (driver_approved, online, heartbeat, offer_valid,
--    insufficient_balance) se preserva intacto.
--
-- 4) `complete_ride_and_pay` strict parity: si existe snapshot estimate,
--    `final_fare_cup := snapshot.total + wait_charge - discount`
--    (sin recálculo con km/min reales). Solo aplica recálculo legacy
--    cuando el snapshot estimate falta (rides creados pre-trigger).
--
-- Preserva verbatim: caller check, corporate variable commission
-- override (00236), todos los payment dispatch branches (tricicoin /
-- mixed / tropipay / corporate / cash + splits + insurance), driver
-- tricicoin commission debit.
-- ============================================================

-- ── 1) Schema: extender ride_pricing_snapshots ──
ALTER TABLE public.ride_pricing_snapshots
  ADD COLUMN IF NOT EXISTS min_fare INTEGER,
  ADD COLUMN IF NOT EXISTS corporate_commission_rate NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS default_commission_rate_snapshot NUMERIC(5,4);

COMMENT ON COLUMN public.ride_pricing_snapshots.min_fare IS
  '00299: min_fare floor efectivo en el momento del snapshot. El RPC '
  'complete_ride_and_pay lo prefiere sobre service_type_configs.min_fare_cup '
  'cuando existe.';
COMMENT ON COLUMN public.ride_pricing_snapshots.corporate_commission_rate IS
  '00299: corporate_accounts.commission_percent/100 snapshoteado al crear '
  'el ride. NULL para rides no corporativos.';
COMMENT ON COLUMN public.ride_pricing_snapshots.default_commission_rate_snapshot IS
  '00299: platform_config.commission_rate snapshoteado al crear el ride.';

-- ── 2) Trigger: persistir snapshot estimate al INSERT en rides ──
CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_svc                  RECORD;
  v_commission_rate      NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_eff_per_km           INTEGER;
  v_commission_amount    INTEGER;
BEGIN
  -- Skip if estimated_fare_cup not set (defensive — should always be set)
  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  -- Skip if snapshot already exists (defensive idempotency — should not
  -- happen because trigger fires once on INSERT, but if a backfill re-runs
  -- the INSERT path, don't duplicate).
  IF EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = NEW.id AND snapshot_type = 'estimate'
  ) THEN
    RETURN NEW;
  END IF;

  -- Lookup live rates from service_type_configs. If not found, skip
  -- (legacy/test rides with invalid service_type won't get a snapshot,
  -- complete_ride_and_pay falls back to its legacy recalculation path).
  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_eff_per_km := COALESCE(NEW.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  -- Snapshot platform commission_rate at this exact moment
  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  -- Snapshot corporate commission rate if applicable
  IF NEW.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = NEW.corporate_account_id;
  END IF;

  -- Compute commission_amount on the contracted estimated_fare_cup
  -- (the price the rider confirmed). Use corporate rate if active and
  -- lower than default (same logic as complete_ride_and_pay 00236).
  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  INSERT INTO public.ride_pricing_snapshots (
    ride_id,
    snapshot_type,
    base_fare,
    per_km_rate,
    per_minute_rate,
    distance_m,
    duration_s,
    surge_multiplier,
    subtotal,
    commission_rate,
    commission_amount,
    total,
    pricing_rule_id,
    exchange_rate_usd_cup,
    total_trc,
    min_fare,
    corporate_commission_rate,
    default_commission_rate_snapshot
  ) VALUES (
    NEW.id,
    'estimate',
    v_svc.base_fare_cup,
    v_eff_per_km,
    v_svc.per_minute_rate_cup,
    NEW.estimated_distance_m,
    NEW.estimated_duration_s,
    NEW.surge_multiplier,
    NEW.estimated_fare_cup,
    COALESCE(v_corp_commission_rate, v_commission_rate),
    v_commission_amount,
    NEW.estimated_fare_cup,  -- CONTRATO: total = estimated_fare_cup
    NULL,                     -- pricing_rule_id: opcional, TS puede llenarlo
    NEW.exchange_rate_usd_cup,
    NEW.estimated_fare_trc,
    v_svc.min_fare_cup,
    v_corp_commission_rate,
    v_commission_rate
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Defensive: snapshot insertion must never block ride creation.
  -- Log and continue. complete_ride_and_pay will fall back to its
  -- legacy recalculation path for this ride.
  RAISE WARNING 'tg_rides_create_estimate_snapshot failed for ride %: % %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_rides_create_estimate_snapshot IS
  '00299: AFTER INSERT trigger on rides. Persiste snapshot type=estimate '
  'capturando los rates de service_type_configs + platform_config + '
  'corporate_accounts al momento del create. El snapshot es el contrato '
  'inmutable del precio. complete_ride_and_pay lo lee como source of '
  'truth para garantizar paridad estimate↔final.';

DROP TRIGGER IF EXISTS rides_create_estimate_snapshot ON public.rides;
CREATE TRIGGER rides_create_estimate_snapshot
AFTER INSERT ON public.rides
FOR EACH ROW
EXECUTE FUNCTION public.tg_rides_create_estimate_snapshot();

-- ── 3) accept_ride_v2 sin recálculo de fare ──
--
-- Preserva: caller check (auth.uid), driver ownership check, FOR UPDATE
-- ride lock, idempotent re-accept, status='searching' check, offer
-- lookup + valid, driver_approved, driver_online, heartbeat <3min,
-- driver_has_active_ride check, service_config existence check, gate
-- driver_can_afford_commission (no se toca — sigue chequeando tricicoin).
--
-- ELIMINA: el bloque entero que recalculaba v_raw_fare + v_base_fare +
-- v_fare_after_surge + v_estimated_fare_cup. Y el UPDATE que sobrescribía
-- rides.estimated_fare_cup / estimated_fare_trc. Estos campos se
-- preservan tal como los persistió createRide TS.

CREATE OR REPLACE FUNCTION public.accept_ride_v2(p_ride_id uuid, p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_caller_uid       uuid;
  v_ride             rides%ROWTYPE;
  v_driver           driver_profiles%ROWTYPE;
  v_existing_active  rides%ROWTYPE;
  v_offer            ride_offers%ROWTYPE;
  v_svc_config       record;
  v_afford           jsonb;
  v_log_meta         jsonb;
BEGIN
  v_caller_uid := auth.uid();
  v_log_meta   := jsonb_build_object('driver_profile_id', p_driver_id);

  IF v_caller_uid IS NULL THEN
    PERFORM log_rpc_attempt('accept_ride_v2', NULL, p_ride_id, 'unauthenticated', v_log_meta);
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = p_driver_id AND user_id = v_caller_uid
  ) THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'unauthorized', v_log_meta);
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'ride_not_found', v_log_meta);
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  -- Idempotent re-accept (mismo driver, ya aceptado)
  IF v_ride.driver_id = p_driver_id AND v_ride.status IN
     ('accepted','driver_en_route','arrived_at_pickup','in_progress') THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'idempotent', v_log_meta);
    RETURN jsonb_build_object(
      'success', true,
      'ride_id', p_ride_id,
      'idempotent', true,
      'estimated_fare_cup', v_ride.estimated_fare_cup,
      'estimated_fare_trc', v_ride.estimated_fare_trc,
      'driver_custom_rate_cup', v_ride.driver_custom_rate_cup
    );
  END IF;

  IF v_ride.status <> 'searching' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'ride_already_taken',
      v_log_meta || jsonb_build_object('current_status', v_ride.status));
    RETURN jsonb_build_object('error','ride_already_taken','status',v_ride.status);
  END IF;

  SELECT * INTO v_offer FROM ride_offers
  WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_id
    AND status = 'pending' AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'offer_not_found_or_expired', v_log_meta);
    RETURN jsonb_build_object('error','offer_not_found_or_expired');
  END IF;

  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_found', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_found');
  END IF;

  -- DRV-001
  IF v_driver.status <> 'approved' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_approved',
      v_log_meta || jsonb_build_object('driver_status', v_driver.status));
    RETURN jsonb_build_object('error','driver_not_approved','driver_status',v_driver.status);
  END IF;

  IF NOT v_driver.is_online THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_online', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL
     AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_stale_heartbeat', v_log_meta);
    RETURN jsonb_build_object('error','driver_stale_heartbeat');
  END IF;

  SELECT * INTO v_existing_active FROM rides
  WHERE driver_id = p_driver_id
    AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    AND id <> p_ride_id
  LIMIT 1;

  IF FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_has_active_ride',
      v_log_meta || jsonb_build_object('active_ride_id', v_existing_active.id));
    RETURN jsonb_build_object('error','driver_has_active_ride','active_ride_id',v_existing_active.id);
  END IF;

  -- Service config existence check (preserved — if missing, ride can't proceed)
  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc_config
  FROM service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'service_config_missing', v_log_meta);
    RETURN jsonb_build_object('error','service_config_missing');
  END IF;

  -- ── TC gate: insufficient_balance check ──
  -- driver_can_afford_commission lee account 'tricicoin' del driver y
  -- compara contra commission_rate * estimated_fare_cup. Preservado
  -- intacto desde migration 00153_wallet_floor_gate_on_accept.
  v_afford := driver_can_afford_commission(p_driver_id, v_ride.estimated_fare_cup);

  IF NOT (v_afford->>'ok')::boolean THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'insufficient_balance',
      v_log_meta || v_afford);
    RETURN jsonb_build_object(
      'error', 'insufficient_balance',
      'balance_trc', v_afford->'balance_trc',
      'required_trc', v_afford->'required_trc',
      'balance_cup', v_afford->'balance_cup',
      'required_cup', v_afford->'required_cup',
      'commission_rate', v_afford->'commission_rate',
      'wallet_type', v_afford->'wallet_type'
    );
  END IF;

  -- ── 00299 CAMBIO PRINCIPAL ──
  -- ANTES (legacy accept_ride_v2): recalculaba v_raw_fare / v_base_fare /
  -- v_fare_after_surge / v_estimated_fare_cup y SOBRESCRIBÍA
  -- rides.estimated_fare_cup en el UPDATE, anulando el experiment
  -- multiplier que el cliente había visto al pedir el ride.
  --
  -- AHORA: no recalcula nada. estimated_fare_cup queda exactamente como
  -- lo persistió createRide TS (con el experiment multiplier intacto si
  -- aplica) + el snapshot estimate creado por el trigger lo respalda.
  -- Paridad garantizada porque complete_ride_and_pay lee del snapshot.

  UPDATE rides SET
    driver_id              = p_driver_id,
    status                 = 'accepted',
    accepted_at            = now(),
    driver_custom_rate_cup = v_driver.custom_per_km_rate_cup
    -- NO TOCAR: estimated_fare_cup, estimated_fare_trc
  WHERE id = p_ride_id AND status = 'searching';

  UPDATE ride_offers SET status = 'accepted',   responded_at = now() WHERE id = v_offer.id;
  UPDATE ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND id <> v_offer.id AND status = 'pending';

  PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'success',
    v_log_meta || jsonb_build_object(
      'estimated_fare_cup', v_ride.estimated_fare_cup,
      'estimated_fare_trc', v_ride.estimated_fare_trc
    ));

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'estimated_fare_cup', v_ride.estimated_fare_cup,
    'estimated_fare_trc', v_ride.estimated_fare_trc,
    'driver_custom_rate_cup', v_driver.custom_per_km_rate_cup
  );
END;
$$;

COMMENT ON FUNCTION public.accept_ride_v2(uuid, uuid) IS
  '00299: NO recalcula estimated_fare_cup. Preserva el valor que '
  'createRide TS persistió (con experiment multiplier intacto si aplica). '
  'El snapshot estimate creado por el trigger es el contrato. Mantiene '
  'caller check, idempotent re-accept, offer validity, driver_approved/'
  'online/heartbeat/has_active_ride gates, service_config check, '
  'TC insufficient_balance gate via driver_can_afford_commission.';

-- ── 4) complete_ride_and_pay strict parity ──
--
-- Lee snapshot estimate. Si existe:
--   v_final_fare = snapshot.total + wait_charge - discount
--   (sin recálculo con actuals — paridad estricta)
--
-- Si snapshot estimate NO existe (legacy ride pre-trigger):
--   Recálculo con actuals como en 00283, manteniendo cap 1.3× y min_fare.
--
-- Preservado intacto: corporate variable commission (00236), todos los
-- payment dispatch branches (tricicoin / mixed / tropipay / corporate /
-- cash + splits + insurance), driver tricicoin commission debit (cash),
-- wait_charge re-sum, total_rides_completed update.

CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(
  p_ride_id uuid,
  p_driver_id uuid,
  p_actual_distance_m integer,
  p_actual_duration_s integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
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

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = p_driver_id;
  IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden: only the assigned driver can complete this ride';
  END IF;

  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type AND is_active = true;
  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active service config for type: %', v_ride.service_type;
  END IF;

  -- ── Estimate snapshot lookup ──
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
    get_surge_multiplier(v_ride.pickup_location)
  );

  -- ── Wait charge (siempre, ambos paths) ──
  PERFORM calculate_wait_charge(p_ride_id);
  SELECT wait_time_charge_cup INTO v_wait_charge FROM rides WHERE id = p_ride_id;

  IF v_strict_parity THEN
    -- ── 00299 STRICT PARITY PATH ──
    -- El cliente vio v_est.total. Le cobramos exactamente eso, más
    -- wait_charge y menos discount. Sin recálculo con actuals.
    v_fare := v_est.total;
    v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0)
                  + COALESCE(v_wait_charge, 0);
    -- Distancia chargeable se usa solo para snapshot final (record-keeping).
    v_chargeable_distance_m := COALESCE(p_actual_distance_m, v_est.distance_m, 0);
    v_excess_m := 0;  -- en strict parity no hay "excess" porque no cobramos por distancia real
  ELSE
    -- ── LEGACY PATH (rides pre-trigger sin snapshot estimate) ──
    -- Cap chargeable distance at 1.3× estimate to protect the rider.
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
    -- Neutral 40 km/h duration for fare component (BUG-221).
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

  -- ── Commission rates: snapshot > platform_config > fallback 0.15 ──
  v_default_commission_rate := COALESCE(
    v_est.default_commission_rate_snapshot,
    (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'commission_rate'),
    0.15
  );
  v_commission_rate := v_default_commission_rate;

  -- ── Corporate variable commission override (00236, preservado) ──
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
    excess_distance_uncharged_m = v_excess_m,
    share_token = v_share_token,
    payment_status = v_payment_status
  WHERE id = p_ride_id;

  -- Snapshot final
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

  -- ── Payment dispatch — preserved verbatim ──

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

  ELSIF v_payment_method_text = 'mixed' THEN
    v_wallet_amount := ROUND(v_final_fare_trc * COALESCE(v_ride.wallet_ratio, 0));
    v_cash_amount := v_final_fare_trc - v_wallet_amount;

    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), v_customer_balance);
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

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, -v_commission_amount, v_driver_tricicoin_balance - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_tricicoin_account_id;
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
    -- Cash branch
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
      v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
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
    'min_fare_used', v_eff_min_fare,
    'corporate_commission_rate_used', v_corp_commission_rate,
    'default_commission_rate_used', v_default_commission_rate
  );
END;
$$;

COMMENT ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) IS
  '00299: strict parity. Si existe snapshot estimate (creado por trigger '
  'rides_create_estimate_snapshot), final_fare = snapshot.total + '
  'wait_charge - discount sin recálculo. Si no existe (rides legacy '
  'pre-trigger), recálculo con cap 1.3× sobre actuals + min_fare. '
  'Preserva: corporate variable commission (00236), todos los payment '
  'dispatch branches (tricicoin / mixed / tropipay / corporate / cash + '
  'splits + insurance), driver tricicoin commission debit, wait_charge '
  're-sum via calculate_wait_charge.';
