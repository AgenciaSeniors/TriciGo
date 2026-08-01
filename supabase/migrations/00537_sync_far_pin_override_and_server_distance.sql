-- 00537: Sync prod hotfixes for incident b428022b (far-from-pin completion)
--
-- CONTEXT. Ride b428022b (2026-08-01): the dropoff pin was geocoded 1,650 m away
-- from the real destination ("31 Calle 4, Calle 3ra e/ Calle 4 y 2" is ambiguous).
-- The driver reached the real destination but could not finish the ride — the
-- client-side proximity lock blocked the button, the RPC was never called (zero
-- telemetry), and he ended up driving 1.6 km back, empty, to the wrong pin just
-- so the app would let him complete. actual_distance_m stored the ESTIMATE
-- (1,298 m) while the GPS trail shows 5,586 m, and duplicated GPS events with
-- mixed clocks (offline buffer replay without idempotency) polluted the trail.
--
-- These fixes were applied DIRECTLY to prod on 2026-08-01 via the Supabase MCP
-- (claude.ai session "Problema con dirección en viaje activo"). This migration
-- records them in git so the repo matches prod. Function bodies are transcribed
-- VERBATIM from pg_get_functiondef() and md5-verified against pg_proc.prosrc:
--   update_ride_status_v2         0127dfedde6c8f7bbb8185a6086a6ae5
--   log_ride_validation_event     77eafdc2b6e4dc4bbbef0f90a880022a
--   compute_ride_trail_distance_m 998812627ebecafc302397e20f0f3d6d
--   complete_ride_and_pay         4bac6be392c312bedfc93fc04da508ec
--
-- WHAT CHANGED (Paso 1 + Paso 2 of the incident plan):
-- 1. update_ride_status_v2 gains p_confirm_far (default false — no behavior
--    change for current apps). Path B.4: at > bypass_max_m (500 m) from the
--    dropoff pin, the driver can explicitly confirm the passenger arrived
--    (modal in the app -> retry with p_confirm_far: true). Stores the real
--    position in rides.actual_dropoff_location, flags completed_far_from_pin,
--    and emits validation_event 'arrived_far_from_pin'. Destination only:
--    a pickup override would allow inflating the wait charge.
-- 2. log_ride_validation_event: RPC so the app can log client-side blocks
--    ('complete_blocked_distance', 'far_pin_override_canceled') — server-side
--    RAISE EXCEPTION rolls back and swallows its own telemetry.
-- 3. compute_ride_trail_distance_m: real distance from the ride's GPS trail,
--    ignoring <3 m jitter and discarding >35 m/s teleports (the signature of
--    offline-buffer replay with mixed clocks).
-- 4. complete_ride_and_pay: server-computed distance is the source of truth;
--    the client value is audited in rides.reported_distance_m and a
--    'distance_mismatch' validation_event fires when they diverge >25% and
--    >150 m. Falls back to the client value when there is no usable trail
--    (no-GPS mode). Normal fares DO NOT change (strict parity path still
--    charges the estimate snapshot). Also backstops arrived_at_destination_at
--    (was NULL on every completed ride).
-- 5. ride_location_events.client_event_id + UNIQUE (ride_id, client_event_id):
--    idempotency so the offline buffer replay cannot duplicate GPS points.
--
-- Idempotent: safe to re-run against prod (everything already applied there).

-- ============================================================
-- Columns
-- ============================================================

ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS completed_far_from_pin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS actual_dropoff_location geography(Point, 4326),
  ADD COLUMN IF NOT EXISTS reported_distance_m integer;

COMMENT ON COLUMN public.rides.completed_far_from_pin IS
  'true si el conductor confirmó llegada a >bypass_max_m del pin de destino (pin mal geocodificado). Ver validation_events arrived_far_from_pin.';
COMMENT ON COLUMN public.rides.actual_dropoff_location IS
  'Posición GPS real del conductor al confirmar llegada lejos del pin. Fuente para corregir geocoding.';
COMMENT ON COLUMN public.rides.reported_distance_m IS
  'actual_distance_m tal como lo envió la app del conductor. actual_distance_m pasa a ser el valor calculado en servidor desde ride_location_events.';

ALTER TABLE public.ride_location_events
  ADD COLUMN IF NOT EXISTS client_event_id uuid;

COMMENT ON COLUMN public.ride_location_events.client_event_id IS
  'UUID generado por la app por cada fix GPS. Unique (ride_id, client_event_id) para que el replay del buffer offline no duplique puntos. NULL en filas históricas.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ride_location_client_event
  ON public.ride_location_events USING btree (ride_id, client_event_id);

-- ============================================================
-- compute_ride_trail_distance_m — real distance from the GPS trail
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_ride_trail_distance_m(p_ride_id uuid, p_since timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  rec RECORD;
  v_prev geography := NULL;
  v_prev_at timestamptz := NULL;
  v_total numeric := 0;
  v_seg numeric;
  v_dt numeric;
  v_points integer := 0;
  -- 35 m/s (~126 km/h): un segmento que implique más velocidad es un salto
  -- entre streams con relojes distintos (replay offline), no movimiento real.
  v_max_speed numeric := 35;
  -- <3 m entre fixes es jitter de GPS parado; no suma pero ancla el tiempo.
  v_min_step numeric := 3;
BEGIN
  FOR rec IN
    SELECT location::geography AS g, recorded_at
    FROM ride_location_events
    WHERE ride_id = p_ride_id
      AND recorded_at >= p_since
    ORDER BY recorded_at, id
  LOOP
    v_points := v_points + 1;
    IF v_prev IS NULL THEN
      v_prev := rec.g;
      v_prev_at := rec.recorded_at;
      CONTINUE;
    END IF;

    v_seg := ST_Distance(v_prev, rec.g);
    v_dt := GREATEST(EXTRACT(EPOCH FROM (rec.recorded_at - v_prev_at)), 0.001);

    IF v_seg < v_min_step THEN
      -- jitter / duplicado en el mismo punto: avanza el ancla temporal
      v_prev := rec.g;
      v_prev_at := rec.recorded_at;
    ELSIF (v_seg / v_dt) <= v_max_speed THEN
      v_total := v_total + v_seg;
      v_prev := rec.g;
      v_prev_at := rec.recorded_at;
    ELSE
      -- teleport: se descarta el punto y se mantiene el ancla previa,
      -- así el stream intruso completo queda fuera del acumulado.
      NULL;
    END IF;
  END LOOP;

  IF v_points < 2 THEN
    RETURN NULL;
  END IF;
  RETURN ROUND(v_total)::integer;
END;
$function$;

-- ============================================================
-- log_ride_validation_event — client-side block telemetry
-- ============================================================

CREATE OR REPLACE FUNCTION public.log_ride_validation_event(p_ride_id uuid, p_event_type text, p_properties jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_driver_user_id uuid;
BEGIN
  SELECT id, driver_id, customer_id INTO v_ride FROM rides WHERE id = p_ride_id;
  IF v_ride.id IS NULL THEN
    RAISE EXCEPTION 'Ride not found';
  END IF;
  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = v_ride.driver_id;
  IF NOT is_admin()
     AND auth.uid() IS DISTINCT FROM v_driver_user_id
     AND auth.uid() IS DISTINCT FROM v_ride.customer_id THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_event_type NOT IN ('complete_blocked_distance', 'far_pin_override_canceled') THEN
    RAISE EXCEPTION 'Event type not allowed: %', p_event_type;
  END IF;
  IF pg_column_size(p_properties) > 2048 THEN
    RAISE EXCEPTION 'Properties too large';
  END IF;
  INSERT INTO validation_events (driver_id, event_type, ride_id, properties)
  VALUES (
    COALESCE(v_driver_user_id, auth.uid()),
    p_event_type,
    p_ride_id,
    COALESCE(p_properties, '{}'::jsonb) || jsonb_build_object('reported_by', auth.uid())
  );
END;
$function$;

-- ============================================================
-- update_ride_status_v2 — adds p_confirm_far (Path B.4)
-- ============================================================

-- Adding a parameter changes the signature: drop the 5-param overload first
-- (otherwise CREATE creates an overload and PostgREST calls become ambiguous).
-- No-op on prod, where only the 6-param version exists.
DROP FUNCTION IF EXISTS public.update_ride_status_v2(uuid, text, double precision, double precision, boolean);

CREATE OR REPLACE FUNCTION public.update_ride_status_v2(p_ride_id uuid, p_new_status text, p_driver_lat double precision DEFAULT NULL::double precision, p_driver_lng double precision DEFAULT NULL::double precision, p_no_gps_mode boolean DEFAULT false, p_confirm_far boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ride          rides%ROWTYPE;
  v_driver_user_id UUID;
  v_driver_pos    GEOGRAPHY;
  v_distance_m    DOUBLE PRECISION;
  v_target        GEOGRAPHY;
  v_target_label  TEXT;
  v_target_es     TEXT;
  v_trail_since   TIMESTAMPTZ;
  v_trail_at      TIMESTAMPTZ;
  v_threshold_m   INTEGER := 100;
  v_bypass_max_m  INTEGER := 500;
BEGIN
  -- RLC-01 (audit round 6): reject terminal / payment-bearing transitions.
  -- complete_ride_and_pay is the ONLY path allowed to set 'completed' (it moves
  -- money + writes the final snapshot); cancel_ride owns 'canceled'/'disputed'.
  -- The FSM trigger allows in_progress->completed for role 'driver' and cannot
  -- distinguish complete_ride_and_pay's UPDATE from a raw one, so the guard must
  -- live in this RPC.
  IF p_new_status IN ('completed', 'canceled', 'disputed') THEN
    RAISE EXCEPTION 'use complete_ride_and_pay / cancel_ride for terminal transitions';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found';
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = v_ride.driver_id;
  IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_new_status = 'arrived_at_pickup' THEN
    v_target := v_ride.pickup_location::geography;
    v_target_label := 'pickup';
    v_target_es := 'punto de recogida';
    v_trail_since := COALESCE(v_ride.accepted_at, v_ride.created_at);
  ELSIF p_new_status = 'arrived_at_destination' THEN
    v_target := v_ride.dropoff_location::geography;
    v_target_label := 'destination';
    v_target_es := 'destino';
    -- Solo el tramo en curso: pasar cerca del destino camino a la recogida
    -- no debe habilitar la llegada.
    v_trail_since := COALESCE(v_ride.pickup_at, v_ride.accepted_at, v_ride.created_at);
  ELSE
    -- BUG-254: cast text -> ride_status. BUG-255: removed the
    -- "UPDATE rides SET driver_en_route_at = ..." line because that
    -- column does not exist; status='driver_en_route' + updated_at
    -- already track the transition.
    UPDATE rides SET status = p_new_status::ride_status, updated_at = now() WHERE id = p_ride_id;
    IF p_new_status = 'in_progress' THEN
      UPDATE rides SET pickup_at = COALESCE(pickup_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status);
  END IF;

  -- BUG-246: rider consented to no-GPS mode -> skip proximity gate entirely
  IF v_ride.driver_gps_status = 'rider_consented' THEN
    UPDATE rides SET status = p_new_status::ride_status, updated_at = now() WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'gated', false,
      'new_status', p_new_status,
      'rider_consented_no_gps', true
    );
  END IF;

  -- Path B: con coordenadas, la verja de proximidad en vivo (B.1 / B.2 / B.3 / B.4).
  -- Sin coordenadas se cae directo al rastro (Path C).
  IF p_driver_lat IS NOT NULL AND p_driver_lng IS NOT NULL THEN
    v_driver_pos := ST_SetSRID(ST_MakePoint(p_driver_lng, p_driver_lat), 4326)::geography;
    v_distance_m := ST_Distance(v_driver_pos, v_target);

    -- Path B.1: GPS within threshold -> auto-allow
    IF v_distance_m <= v_threshold_m THEN
      UPDATE rides SET
        status = p_new_status::ride_status,
        gps_check_distance_m = v_distance_m::integer,
        updated_at = now()
      WHERE id = p_ride_id;
      IF p_new_status = 'arrived_at_pickup' THEN
        UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
      END IF;
      RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status, 'distance_m', v_distance_m::integer);
    END IF;

    -- Path B.2: rider already confirmed bypass (GPS jitter case)
    IF v_ride.gps_override_confirmed_at IS NOT NULL
       AND v_ride.gps_override_confirmed_at > now() - INTERVAL '5 minutes' THEN
      UPDATE rides SET status = p_new_status::ride_status, gps_check_distance_m = v_distance_m::integer, updated_at = now() WHERE id = p_ride_id;
      IF p_new_status = 'arrived_at_pickup' THEN
        UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
      END IF;
      RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status, 'distance_m', v_distance_m::integer, 'rider_bypass_used', true);
    END IF;

    -- Path B.3: between threshold and bypass max -> request rider confirm
    IF v_distance_m <= v_bypass_max_m THEN
      UPDATE rides SET gps_override_requested_at = now(), gps_check_distance_m = v_distance_m::integer WHERE id = p_ride_id;
      RETURN jsonb_build_object('success', false, 'gated', true, 'reason', 'pending_rider_confirmation', 'distance_m', v_distance_m::integer, 'target', v_target_label, 'threshold_m', v_threshold_m);
    END IF;

    -- Path B.4 (fix viaje b428022b): pin de destino mal geocodificado. A más de
    -- v_bypass_max_m del pin, el conductor puede confirmar explícitamente que el
    -- pasajero ya llegó (p_confirm_far=true desde el modal de la app). Se guarda
    -- la posición real como actual_dropoff_location y se emite validation_event
    -- para revisión en admin y corrección del geocoder. Solo destino: en pickup
    -- el override del conductor permitiría inflar el cargo por espera.
    IF p_new_status = 'arrived_at_destination' AND p_confirm_far THEN
      UPDATE rides SET
        status = p_new_status::ride_status,
        gps_check_distance_m = v_distance_m::integer,
        completed_far_from_pin = true,
        actual_dropoff_location = v_driver_pos,
        updated_at = now()
      WHERE id = p_ride_id;
      INSERT INTO validation_events (driver_id, event_type, ride_id, properties)
      VALUES (
        v_driver_user_id,
        'arrived_far_from_pin',
        p_ride_id,
        jsonb_build_object(
          'distance_m', v_distance_m::integer,
          'driver_lat', p_driver_lat,
          'driver_lng', p_driver_lng,
          'bypass_max_m', v_bypass_max_m
        )
      );
      RETURN jsonb_build_object(
        'success', true,
        'gated', false,
        'new_status', p_new_status,
        'distance_m', v_distance_m::integer,
        'far_from_pin_override', true
      );
    END IF;
  END IF;

  -- Path C: sin coordenadas, o demasiado lejos. Último recurso antes de
  -- rechazar: ¿el rastro GPS del propio viaje ya prueba que estuvo ahí?
  -- Cubre el corte de red al llegar — los breadcrumbs se bufferean y se
  -- reinyectan al reconectar, el toque de estado no.
  -- Usa idx_ride_locations_ride (ride_id, recorded_at DESC).
  SELECT MIN(le.recorded_at) INTO v_trail_at
  FROM ride_location_events le
  WHERE le.ride_id = p_ride_id
    AND le.recorded_at >= v_trail_since
    AND ST_Distance(le.location::geography, v_target) <= v_threshold_m;

  IF v_trail_at IS NOT NULL THEN
    UPDATE rides SET
      status = p_new_status::ride_status,
      gps_check_distance_m = COALESCE(v_distance_m::integer, gps_check_distance_m),
      updated_at = now()
    WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      -- Hora real de llegada, no now(): el cargo por espera sale de
      -- (pickup_at - driver_arrived_at) y now() se la inflaría al pasajero.
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, v_trail_at) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'gated', false,
      'new_status', p_new_status,
      'distance_m', v_distance_m::integer,
      'offline_trail_used', true,
      'trail_arrived_at', v_trail_at
    );
  END IF;

  -- Path D: ni coordenadas en vivo ni rastro que lo respalde -> rechazar.
  IF p_driver_lat IS NULL OR p_driver_lng IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No pudimos leer tu GPS. Activa la ubicación e intenta de nuevo; si sigue fallando, el pasajero puede confirmar por ti.',
      DETAIL  = 'gps_required';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = format('Estás a %s m del %s. Acércate más para confirmar.', v_distance_m::integer, v_target_es),
    DETAIL  = 'too_far_for_bypass';
END;
$function$;

-- ============================================================
-- complete_ride_and_pay — server-side distance as source of truth
-- ============================================================

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
    -- 00340 FIX: driver_cash -> tricicoin
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
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
    IF v_promo_disc > 0 AND v_ride.promo_code_id IS NOT NULL THEN
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
$function$;
