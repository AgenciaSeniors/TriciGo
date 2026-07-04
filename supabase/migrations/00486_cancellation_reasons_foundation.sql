-- 00486: cancellation redesign — FASE 1 (fundación money-free).
--
-- Rediseño de la lógica de cancelar (acordado con el usuario). Esta fase:
--   * habilita cancelar `in_progress` para pasajero y conductor (hoy solo admin, 00485);
--   * introduce MOTIVOS ESTRUCTURADOS (enum) en lugar del frágil `%no_show%` de texto libre;
--   * exime de penalización reputacional los motivos legítimos (seguridad/avería/no-show/emergencia)
--     para AMBOS actores (hoy la exención solo cubría al conductor por substring, burlable);
--   * mantiene TODO money-free (fee_cup=0), sin tocar ledger/snapshot/complete_ride_and_pay.
--
-- Diferido a FASE 2 (spec aparte): detección de colusión, cola de revisión en el admin,
-- sanciones fuertes (suspensión + recupero de comisión del wallet tricicoin, baneo),
-- "reportar cancelación", y pasar el castigo post-contacto de automático → discrecional.
--
-- Set de motivos:
--   No exentos (progresión reputacional normal): changed_plans, driver_delay, wrong_price, other
--   Exentos (no penalizan):                      no_show, passenger_gone, breakdown, safety, emergency
--   (back-compat: la app vieja del conductor manda 'passenger_no_show' → también exento)

-- ── a. Columna de motivo estructurado ───────────────────────────────────────
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_reason_code text;

ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_cancellation_reason_code_chk;
ALTER TABLE rides ADD CONSTRAINT rides_cancellation_reason_code_chk
  CHECK (cancellation_reason_code IS NULL OR cancellation_reason_code = ANY (ARRAY[
    'changed_plans','driver_delay','wrong_price','other',
    'no_show','passenger_gone','breakdown','safety','emergency'
  ]));

-- Índice parcial para la detección de la Fase 2 (par repetido / tasa por conductor).
CREATE INDEX IF NOT EXISTS idx_rides_cancellation_reason_code
  ON rides (cancellation_reason_code) WHERE cancellation_reason_code IS NOT NULL;

-- ── b. Abrir el FSM: in_progress → canceled para {customer, driver} ──────────
-- Unión idempotente con {admin,super_admin} de 00485. NO se abre
-- arrived_at_destination a usuarios (queda solo-completar / admin).
INSERT INTO valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('in_progress', 'canceled', ARRAY['customer','driver']::user_role[])
ON CONFLICT (from_status, to_status)
DO UPDATE SET allowed_roles = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(valid_transitions.allowed_roles || EXCLUDED.allowed_roles)
  )
);

-- ── c. Endurecer cancel_ride (patch in-place sobre el cuerpo VIVO) ───────────
-- NO se reescriben las ~150 líneas (riesgo de perder features, cf. 00124):
-- se parte del cuerpo vivo y se reemplazan 2 substrings únicos, idempotente.
DO $patch$
DECLARE v_src text;
BEGIN
  BEGIN
    v_src := pg_get_functiondef('public.cancel_ride(uuid,text)'::regprocedure);
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '00486: cancel_ride ausente; skip patch';
    RETURN;
  END;

  -- (c1) Exención por CÓDIGO estructurado en vez de substring de texto libre.
  --      Aplica a AMBOS actores (antes: solo v_is_driver + ILIKE %no_show%).
  IF position('%no_show%' IN v_src) > 0 THEN
    v_src := replace(
      v_src,
      'v_is_driver AND COALESCE(p_reason, '''') ILIKE ''%no_show%''',
      'COALESCE(p_reason, '''') = ANY(ARRAY[''no_show'',''passenger_no_show'',''passenger_gone'',''breakdown'',''safety'',''emergency''])'
    );
  END IF;

  -- (c2) Persistir el motivo estructurado en la columna nueva.
  IF position('cancellation_reason_code' IN v_src) = 0 THEN
    v_src := replace(
      v_src,
      'cancellation_reason = COALESCE(p_reason, cancellation_reason)',
      'cancellation_reason = COALESCE(p_reason, cancellation_reason), cancellation_reason_code = CASE WHEN p_reason = ANY(ARRAY[''changed_plans'',''driver_delay'',''wrong_price'',''other'',''no_show'',''passenger_gone'',''breakdown'',''safety'',''emergency'']) THEN p_reason ELSE cancellation_reason_code END'
    );
  END IF;

  EXECUTE v_src;
  RAISE NOTICE '00486: cancel_ride patched (exención por código + persistencia de reason_code)';
END $patch$;

-- ── d. preview_cancellation_rating_impact: aceptar el motivo y reflejar exención ──
-- Necesita un parámetro de motivo (la preview corre ANTES de cancelar, así que el
-- código todavía no está en la fila). Read-only y corto → se recrea entero con el
-- parámetro nuevo + la exención. DROP de la firma vieja (uuid) para evitar overload.
DROP FUNCTION IF EXISTS public.preview_cancellation_rating_impact(uuid);

CREATE OR REPLACE FUNCTION public.preview_cancellation_rating_impact(
  p_ride_id uuid,
  p_reason  text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid   uuid := auth.uid();
  v_ride         rides%ROWTYPE;
  v_is_customer  boolean := false;
  v_is_driver    boolean := false;
  v_window_s     integer := 120;
  v_active       boolean := false;
  v_within_grace boolean := false;
  v_eligible     boolean := false;
  v_count_24h    integer := 0;
  v_rating_value numeric := NULL;
  v_is_grace     boolean := true;
  v_stars_before numeric := NULL;
  v_stars_after  numeric := NULL;
  v_window_days  numeric := get_platform_config_numeric('cancel_rating_event_window_days', 90);
  v_sum numeric; v_cnt numeric;
BEGIN
  IF v_caller_uid IS NULL THEN RETURN jsonb_build_object('error','unauthenticated'); END IF;
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;

  v_is_customer := (v_ride.customer_id = v_caller_uid);
  IF v_ride.driver_id IS NOT NULL THEN
    v_is_driver := EXISTS (SELECT 1 FROM driver_profiles WHERE id = v_ride.driver_id AND user_id = v_caller_uid);
  END IF;

  SELECT COALESCE(free_cancel_window_s, 120) INTO v_window_s
    FROM cancellation_fee_configs WHERE service_type = v_ride.service_type AND is_active = true;
  IF v_window_s IS NULL THEN v_window_s := 120; END IF;

  v_active := v_ride.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress');
  v_within_grace := (v_ride.accepted_at IS NOT NULL
                     AND EXTRACT(EPOCH FROM (now() - v_ride.accepted_at)) <= v_window_s);
  -- 00486: los motivos exentos no penalizan (seguridad/avería/no-show/emergencia).
  -- 'passenger_no_show' es el string legacy que manda la app vieja del conductor.
  v_eligible := v_active AND NOT v_within_grace
                AND NOT (COALESCE(p_reason,'') = ANY(ARRAY['no_show','passenger_no_show','passenger_gone','breakdown','safety','emergency']));

  IF v_is_driver THEN
    SELECT rating_avg INTO v_stars_before FROM driver_profiles WHERE user_id = v_caller_uid;
  ELSE
    SELECT rating_avg INTO v_stars_before FROM customer_profiles WHERE user_id = v_caller_uid;
  END IF;
  v_stars_after := v_stars_before;

  IF v_eligible THEN
    SELECT COUNT(*) INTO v_count_24h
      FROM cancellation_rating_events
     WHERE user_id = v_caller_uid AND created_at > now() - INTERVAL '24 hours';
    v_rating_value := CASE
      WHEN v_count_24h = 0 THEN NULL
      WHEN v_count_24h = 1 THEN get_platform_config_numeric('cancel_rating_value_second', 3.0)
      ELSE                        get_platform_config_numeric('cancel_rating_value_third', 2.0)
    END;
    v_is_grace := (v_rating_value IS NULL);

    IF v_rating_value IS NOT NULL THEN
      SELECT COALESCE(SUM(s.val),0), COUNT(s.val) INTO v_sum, v_cnt
      FROM (
        SELECT r.rating::numeric AS val FROM reviews r
          WHERE r.reviewee_id = v_caller_uid AND r.is_visible = true
        UNION ALL
        SELECT ce.rating_value FROM cancellation_rating_events ce
          WHERE ce.user_id = v_caller_uid AND ce.rating_value IS NOT NULL
            AND (v_window_days <= 0 OR ce.created_at > now() - (v_window_days || ' days')::interval)
      ) s;
      v_stars_after := GREATEST(1.00, LEAST(5.00,
        ROUND((v_sum + v_rating_value) / (v_cnt + 1), 2)));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_eligible,
    'is_grace', v_is_grace,
    'rating_penalized', (v_eligible AND v_rating_value IS NOT NULL),
    'cancel_count_24h', v_count_24h,
    'rating_value', v_rating_value,
    'stars_before', v_stars_before,
    'stars_after', v_stars_after
  );
END;
$function$;
