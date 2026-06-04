-- ============================================================
-- 00377 — Stop accept_ride_v2 (and recalc_ride_estimate_with_waypoints)
--         from overwriting / discount-subtracting estimated_fare_cup.
--
-- BUG (verificado en prod 2026-06-04, viaje 6b61d130):
--   El cliente vio un estimado (contrato) de 2200 CUP; el snapshot
--   `estimate` lo fijó en 2200; complete_ride_and_pay liquidó por
--   paridad estricta 2200 − 308 descuento = 1892 (correcto). PERO
--   rides.estimated_fare_cup quedó en 1132 = min_fare(1440) −
--   descuento(308). Las apps que leen esa columna (oferta/viaje activo
--   del conductor) mostraron 1132, contradiciendo 2200 y 1892.
--
-- CAUSA RAÍZ:
--   La versión viva de accept_ride_v2 (= 00367) RECALCULA el estimado al
--   aceptar y lo SOBRESCRIBE en el UPDATE rides, con dos errores:
--     1) recalcula con una fórmula SQL pura que NO replica el estimado
--        que el cliente vio (createRide TS / getLocalFareEstimate);
--     2) le RESTA el descuento: GREATEST(fare_after_surge − discount, 0),
--        guardando un valor POST-descuento (estimated_fare_cup debe ser
--        BRUTO; el descuento se aplica aparte al liquidar).
--   Reproducción exacta: ROUND(285 + 1.306×330 + 8.617×16)=854 →
--   GREATEST(854, min_fare 1440)=1440 → 1440×1.0=1440 →
--   GREATEST(1440 − 308, 0) = 1132.
--
--   Esto VIOLA el diseño de 00299 (paridad estricta), que eliminó ese
--   bloque ("NO TOCAR: estimated_fare_cup, estimated_fare_trc"). La
--   regresión se reintrodujo en 00333 (catch unique_violation, copió un
--   cuerpo pre-00299) y 00337 / 00367 la arrastraron verbatim. Patrón
--   "cadena CREATE OR REPLACE perdió un feature".
--
-- FIX:
--   A) accept_ride_v2: reproduce el cuerpo vivo de 00367 (preserva el
--      fleet gate de 00337, el afford gate de 00367, y el handler
--      unique_violation de 00333) PERO elimina el recálculo de fare y
--      NO toca estimated_fare_cup / estimated_fare_trc en el UPDATE. El
--      afford gate usa v_ride.estimated_fare_cup (el bruto contratado).
--   B) recalc_ride_estimate_with_waypoints: al cambiar waypoints SÍ debe
--      actualizar el snapshot (la ruta cambió → el contrato cambia, y
--      complete_ride_and_pay lee del snapshot), pero debe guardar el
--      BRUTO (with_surge), NO with_surge − discount. Guardar post-descuento
--      hacía que complete_ride_and_pay restara el descuento DOS VECES.
--   C) Backfill: rides.estimated_fare_cup := snapshot.total para las filas
--      con drift (cosmético; el dinero ya quedó bien vía snapshot).
--
-- NOT applied to prod yet (MCP guard). Aplicar tras autorización explícita.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- A) accept_ride_v2 — no recompute, no estimate overwrite
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_ride_v2(p_ride_id uuid, p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid             uuid;
  v_ride                   rides%ROWTYPE;
  v_driver                 driver_profiles%ROWTYPE;
  v_existing_active        rides%ROWTYPE;
  v_offer                  ride_offers%ROWTYPE;
  v_svc_config             record;
  v_custom_rate            numeric;
  v_log_meta               jsonb;
  v_fleet_required         boolean := false;
  v_driver_in_fleet        boolean := false;
  v_afford                 jsonb;   -- 00367: commission affordability result
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

  -- 00337 — Fleet membership gate. Mirrors find_best_drivers (00336):
  -- only enforce when corp exists, is_fleet_owner=true, AND has >=1
  -- active fleet_member. Defensive: silent passthrough if 0 members.
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_fleet_required;

    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM fleet_members fm
        JOIN driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_driver.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;

      IF NOT v_driver_in_fleet THEN
        PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'not_in_fleet',
          v_log_meta || jsonb_build_object(
            'corporate_account_id', v_ride.corporate_account_id,
            'driver_user_id', v_driver.user_id
          ));
        RETURN jsonb_build_object(
          'error', 'not_in_fleet',
          'corporate_account_id', v_ride.corporate_account_id
        );
      END IF;
    END IF;
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

  -- Validate the service type is configured (defensive — the ride should not
  -- exist otherwise). We do NOT use these rates to recompute the fare anymore.
  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc_config
  FROM service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'service_config_missing', v_log_meta);
    RETURN jsonb_build_object('error','service_config_missing');
  END IF;

  v_custom_rate := v_driver.custom_per_km_rate_cup;

  -- ── 00377 CAMBIO PRINCIPAL ──
  -- NO recalcular el estimado. estimated_fare_cup / estimated_fare_trc son el
  -- CONTRATO fijado por createRide TS + el snapshot estimate (00299). Restaurar
  -- el diseño de 00299: accept_ride_v2 solo hace gating + status='accepted'.
  -- (La regresión de 00333/00367 recalculaba con fórmula SQL pura y RESTABA el
  -- descuento, corrompiendo la columna que muestran las apps.)

  -- 00367 — Commission affordability gate (G1). Block the driver if their
  -- balance can't cover this ride's commission. Usa el BRUTO existente
  -- (v_ride.estimated_fare_cup), el contrato — NO un valor recalculado.
  -- Defensive: allow when `ok` is null (helper couldn't determine).
  v_afford := driver_can_afford_commission(p_driver_id, v_ride.estimated_fare_cup);
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'insufficient_balance',
      v_log_meta || v_afford);
    RETURN jsonb_build_object(
      'error',           'insufficient_balance',
      'balance_trc',     (v_afford->>'balance_trc')::int,
      'required_trc',    (v_afford->>'required_trc')::int,
      'commission_rate', (v_afford->>'commission_rate')::numeric
    );
  END IF;

  BEGIN
    UPDATE rides SET
      driver_id              = p_driver_id,
      status                 = 'accepted',
      accepted_at            = now(),
      driver_custom_rate_cup = v_custom_rate
      -- 00377: NO TOCAR estimated_fare_cup, estimated_fare_trc.
    WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing_active FROM rides
      WHERE driver_id = p_driver_id
        AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
        AND id <> p_ride_id
      LIMIT 1;
      PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_has_active_ride_race',
        v_log_meta || jsonb_build_object('active_ride_id', v_existing_active.id));
      RETURN jsonb_build_object(
        'error','driver_has_active_ride',
        'active_ride_id', v_existing_active.id,
        'race', true
      );
  END;

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
    'driver_custom_rate_cup', v_custom_rate
  );
END;
$function$;

COMMENT ON FUNCTION public.accept_ride_v2(uuid, uuid) IS
  '00377: NO recalcula ni sobrescribe estimated_fare_cup/trc (restaura 00299, '
  'revierte la regresión de 00333/00367). Preserva caller/idempotent/offer/'
  'approved/online/heartbeat gates, fleet gate (00337) y el afford gate (00367, '
  'que usa el bruto v_ride.estimated_fare_cup) + handler unique_violation (00333).';

-- ─────────────────────────────────────────────────────────────
-- B) recalc_ride_estimate_with_waypoints — store GROSS, not net-of-discount
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recalc_ride_estimate_with_waypoints(
  p_ride_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ride                 rides%ROWTYPE;
  v_svc                  RECORD;
  v_path_geom            geometry;
  v_total_dist_m         numeric;
  v_total_dur_s          numeric;
  v_speed_kmh            numeric := 25;  -- urban Cuba avg, matches client fareCalculator
  v_eff_per_km           numeric;
  v_raw_fare             int;
  v_base_fare            int;
  v_gross_est            int;            -- 00377: BRUTO (with surge, sin descuento)
  v_commission_rate      numeric;
  v_corp_commission_rate numeric;
  v_commission_amount    int;
  v_existing_snapshot    boolean;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Only recalc for active rides (skip cancelled/completed)
  IF v_ride.status NOT IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  ) THEN
    RETURN;
  END IF;

  -- Build LINESTRING: pickup → waypoints (sorted) → dropoff
  WITH points AS (
    SELECT v_ride.pickup_location::geometry AS geom, 0 AS ord
    UNION ALL
    SELECT w.location::geometry, w.sort_order + 1
      FROM ride_waypoints w
      WHERE w.ride_id = p_ride_id
    UNION ALL
    SELECT v_ride.dropoff_location::geometry, 9999
  ),
  ordered AS (
    SELECT geom FROM points ORDER BY ord
  )
  SELECT ST_MakeLine(geom) INTO v_path_geom FROM ordered;

  IF v_path_geom IS NULL THEN
    RETURN;
  END IF;

  v_total_dist_m := ST_Length(v_path_geom::geography);

  IF v_total_dist_m < 100 THEN
    RETURN;
  END IF;

  v_total_dur_s := (v_total_dist_m / 1000.0) / v_speed_kmh * 3600.0;

  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc
  FROM public.service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_eff_per_km := COALESCE(v_ride.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  v_raw_fare := ROUND(
    v_svc.base_fare_cup
    + (v_total_dist_m / 1000.0) * v_eff_per_km
    + (v_total_dur_s / 60.0) * v_svc.per_minute_rate_cup
  )::int;
  v_base_fare := GREATEST(v_raw_fare, v_svc.min_fare_cup);

  -- 00377: GROSS = base after surge, SIN restar el descuento. El snapshot
  -- estimate y rides.estimated_fare_cup son el BRUTO (contrato); el descuento
  -- lo aplica complete_ride_and_pay una sola vez (final = snapshot.total −
  -- discount). Restar aquí provocaba un descuento DOBLE en rides con waypoints.
  v_gross_est := ROUND(v_base_fare * COALESCE(v_ride.surge_multiplier, 1.0))::int;

  -- Commission snapshot sobre el BRUTO (igual que tg_rides_create_estimate_snapshot 00299)
  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
    FROM public.platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
      FROM public.corporate_accounts WHERE id = v_ride.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(v_gross_est * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(v_gross_est * v_commission_rate)::int;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM ride_pricing_snapshots
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate'
  ) INTO v_existing_snapshot;

  IF v_existing_snapshot THEN
    UPDATE ride_pricing_snapshots SET
      base_fare         = v_svc.base_fare_cup,
      per_km_rate       = v_eff_per_km,
      per_minute_rate   = v_svc.per_minute_rate_cup,
      distance_m        = ROUND(v_total_dist_m)::int,
      duration_s        = ROUND(v_total_dur_s)::int,
      subtotal          = v_gross_est,
      total             = v_gross_est,
      commission_rate   = COALESCE(v_corp_commission_rate, v_commission_rate),
      commission_amount = v_commission_amount,
      min_fare          = v_svc.min_fare_cup
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate';
  END IF;

  -- Also update rides.estimated_* so UI/legacy paths see consistent values.
  -- estimated_fare_cup is GROSS; discount_amount_cup stays as-is (recomputed
  -- by tg_rides_validate_promo_discount on its own trigger columns). Nota:
  -- el descuento NO se re-dispara aquí (evita re-claim de promo); para shared
  -- rides que agregan waypoints el descuento queda levemente conservador.
  UPDATE rides SET
    estimated_distance_m = ROUND(v_total_dist_m)::int,
    estimated_duration_s = ROUND(v_total_dur_s)::int,
    estimated_fare_cup   = v_gross_est,
    estimated_fare_trc   = v_gross_est  -- 1:1 fallback (cup_to_trc done lazily)
  WHERE id = p_ride_id;
END;
$$;

COMMENT ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) IS
  '00377: recomputes distance/duration/fare from pickup→waypoints→dropoff and '
  'stores the GROSS estimate (with surge, sin restar descuento) en '
  'ride_pricing_snapshots(estimate) + rides.estimated_*. Antes restaba el '
  'descuento → complete_ride_and_pay lo restaba dos veces. Speed 25 km/h.';

-- ─────────────────────────────────────────────────────────────
-- C) Backfill — restore display estimate from the contract snapshot
-- ─────────────────────────────────────────────────────────────
-- Para filas donde la columna estimated_fare_cup quedó corrupta (≠ snapshot
-- estimate total) por la regresión. Cosmético: el dinero ya se liquidó vía
-- snapshot. Solo toca estimated_fare_cup/trc → no dispara el trigger de
-- descuento (UPDATE OF promo_code_id/discount/shared_ride). En contexto de
-- migración auth.uid() IS NULL → enforce_ride_update_columns hace passthrough.
UPDATE public.rides r
SET estimated_fare_cup = s.total,
    estimated_fare_trc = COALESCE(s.total_trc, s.total)
FROM public.ride_pricing_snapshots s
WHERE s.ride_id = r.id
  AND s.snapshot_type = 'estimate'
  AND r.estimated_fare_cup IS DISTINCT FROM s.total;
