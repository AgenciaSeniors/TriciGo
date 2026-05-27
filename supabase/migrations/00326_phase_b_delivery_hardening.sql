-- 00326_phase_b_delivery_hardening.sql
-- ============================================================
-- Delivery audit — Fase B. Higiene de matching, emails e índices
-- ============================================================
-- Fase A (00325 + PR #242) cerró los 3 gaps críticos del flujo
-- (OTP UI driver, OTP visible al customer, trigger notify-recipient,
-- tracking público con card cargo). Esta migración aborda los 3
-- gaps medios + un cleanup de datos zombie:
--
--   B-G4 — find_best_drivers fail-closed para cargo
--   B-G5 — trg_send_ride_receipt solo para passenger (deduplicar email)
--   B-G6 — Índice parcial sobre rides cargo
--   Cleanup — driver con current_location zombie en Paraguay
--
-- 100% DB-only — sin cambios de frontend.
-- ============================================================


-- ------------------------------------------------------------
-- B-G4. find_best_drivers — cerrar fail-open en filtros cargo
-- ------------------------------------------------------------
-- Cuando el cliente especifica peso/categoría/dimensiones, el vehículo
-- DEBE tener ese campo definido y compatible. Antes: `OR col IS NULL`
-- (fail-open) → drivers con accepts_cargo=true pero sin config (caso
-- real: Eduardo Admin) recibían ofertas que no podían transportar.
--
-- Cambios (5 lugares): para cada filtro cargo, sustituir
--     OR v.col IS NULL OR v.col >= p_param
-- por
--     OR (v.col IS NOT NULL AND v.col >= p_param)
--
-- Cuando el cliente NO especifica (p_param IS NULL), el vehículo sigue
-- elegible — UX intacta para deliveries genéricos.
--
-- Base: definición canónica de 00262_find_best_drivers_respect_preferences.sql
-- + override actual en prod. Verbatim salvo los 5 filtros cargo.

CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false,
  p_estimated_trip_distance_m integer DEFAULT NULL,
  p_package_category text DEFAULT NULL,
  p_estimated_weight_kg numeric DEFAULT NULL,
  p_package_length_cm integer DEFAULT NULL,
  p_package_width_cm integer DEFAULT NULL,
  p_package_height_cm integer DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  distance_m double precision,
  match_score numeric,
  rating numeric,
  acceptance_rate numeric,
  composite double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_types vehicle_type[];
  v_is_long_trip BOOLEAN;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  v_vehicle_types := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::vehicle_type]
  END;

  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id              AS dp_id,
      dp.user_id         AS dp_user_id,
      dp.match_score     AS dp_match_score,
      dp.rating_avg      AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
        FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status = 'completed'
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND r.accepted_at IS NOT NULL
      )::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      -- ── B-G4: fail-CLOSED para los 5 filtros cargo ──────────────
      AND (
        p_package_category IS NULL
        OR (
          v.accepted_cargo_categories IS NOT NULL
          AND array_length(v.accepted_cargo_categories, 1) > 0
          AND p_package_category = ANY(v.accepted_cargo_categories::text[])
        )
      )
      AND (
        p_estimated_weight_kg IS NULL
        OR (v.max_cargo_weight_kg IS NOT NULL AND v.max_cargo_weight_kg >= p_estimated_weight_kg)
      )
      AND (
        p_package_length_cm IS NULL
        OR (v.max_cargo_length_cm IS NOT NULL AND v.max_cargo_length_cm >= p_package_length_cm)
      )
      AND (
        p_package_width_cm IS NULL
        OR (v.max_cargo_width_cm IS NOT NULL AND v.max_cargo_width_cm >= p_package_width_cm)
      )
      AND (
        p_package_height_cm IS NULL
        OR (v.max_cargo_height_cm IS NOT NULL AND v.max_cargo_height_cm >= p_package_height_cm)
      )
      -- ─────────────────────────────────────────────────────────────
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND (c.id IS NULL OR c.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
  )
  SELECT
    ed.dp_id, ed.dp_user_id, ed.dist_m,
    ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (
      0.30 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
      0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
      0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
      0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
      0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
      0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.find_best_drivers IS
  '00326 audit B-G4: fail-closed para filtros cargo. Drivers sin config quedan excluidos cuando el cliente especifica peso/categoría/dimensiones.';


-- ------------------------------------------------------------
-- B-G5. trg_send_ride_receipt — solo passenger
-- ------------------------------------------------------------
-- Antes el WHEN no filtraba ride_mode → en cargo se disparaban
-- trg_send_ride_receipt + trg_send_delivery_receipt = 2 emails.
-- Mirror del patrón ya usado por trg_send_first_ride_email.

DROP TRIGGER IF EXISTS trg_send_ride_receipt ON public.rides;

CREATE TRIGGER trg_send_ride_receipt
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (
    NEW.status = 'completed'::ride_status
    AND OLD.status IS DISTINCT FROM 'completed'::ride_status
    AND NEW.ride_mode = 'passenger'
  )
  EXECUTE FUNCTION public.send_ride_receipt_email();


-- ------------------------------------------------------------
-- B-G6. Índice parcial sobre rides cargo
-- ------------------------------------------------------------
-- Patrón WHERE ride_mode='cargo' usado por backfill_cargo_bonuses,
-- apply_cargo_completion_bonus, send_delivery_receipt_email,
-- validate_delivery_otp, claim_delivery_notification, dashboards admin.
-- Sin CONCURRENTLY (migración corre en transacción); volumen actual
-- 1/154 rides cargo, lock instantáneo.

CREATE INDEX IF NOT EXISTS idx_rides_cargo
  ON public.rides (ride_mode, status, created_at DESC)
  WHERE ride_mode = 'cargo';


-- ------------------------------------------------------------
-- Cleanup — driver con current_location zombie en Paraguay
-- ------------------------------------------------------------
-- Lucía Soler (4acd1d1a-d491-4268-a5dc-6aa8135a1207) tiene
-- current_location = POINT(-54.5894157 -25.4572124) → Paraguay.
-- is_online=false hoy, pero contamina queries de cobertura
-- geográfica + sería bug si vuelve online sin actualizar GPS.
-- Guard ST_X < -80 hace la migración idempotente: si la location
-- ya está en Cuba (long > -80°) o fue limpiada (NULL), no-op.

UPDATE public.driver_profiles
SET current_location = NULL,
    updated_at = NOW()
WHERE id = '4acd1d1a-d491-4268-a5dc-6aa8135a1207'
  AND current_location IS NOT NULL
  AND ST_X(current_location::geometry) < -80;
