-- 00542: liberar los viajes que quedan secuestrados cuando la app del conductor muere.
--
-- CASO REAL (2026-08-03, ride c99c157d): la app de un conductor dejó de reportar
-- a mitad de camino al pickup. El cron `auto-offline-stale-drivers` detectó el
-- heartbeat muerto y lo marcó offline… pero NUNCA tocó el viaje. El viaje quedó
-- congelado en `driver_en_route` 3h22m y la pasajera quedó bloqueada todo ese
-- tiempo (la regla de un-viaje-activo-por-pasajero le impedía pedir otro).
-- Hubo que destrabarlo a mano.
--
-- El hueco: `auto_offline_stale_drivers` ya SABE quién está muerto pero no
-- resuelve el viaje que ese conductor tiene tomado, y `check_stuck_active_rides`
-- (00538) ni siquiera mira el heartbeat — por eso nadie lo detectó.
-- `cleanup_orphan_searching_rides` solo limpia el estado `searching`.
--
-- REGLA DE SEGURIDAD CENTRAL — la distinción pre/post recogida NO es un refinamiento:
--   * Antes de recoger (`accepted`, `driver_en_route`): el pasajero NO subió al
--     vehículo. Devolvemos el viaje a `searching` para que lo tome otro conductor.
--   * Después de recoger (`arrived_at_pickup`, `in_progress`,
--     `arrived_at_destination`): el pasajero PUEDE ir a bordo. Acá NO se cancela
--     ni se reasigna NUNCA — solo se alerta. Una limpieza ingenua habría destruido
--     el viaje legítimo del ride 2fa97a44, donde el conductor sí llevó a la
--     pasajera hasta el destino con la app muerta.

-- ─────────────────────────────────────────────────────────────
-- 1. Tunables (editables por admin sin redeploy)
-- ─────────────────────────────────────────────────────────────
-- El umbral es MAYOR que `driver_offline_after_minutes` (10) a propósito: primero
-- se le da al conductor la chance de revivir y que el cron lo saque de línea; solo
-- si sigue muerto le soltamos el viaje.
INSERT INTO platform_config (key, value) VALUES
  ('dead_driver_ride_release_after_minutes', '12'::jsonb),
  ('dead_driver_ride_release_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 2. Permitir el motivo nuevo en stuck_ride_alerts
-- ─────────────────────────────────────────────────────────────
ALTER TABLE stuck_ride_alerts DROP CONSTRAINT IF EXISTS stuck_ride_alerts_reason_check;
ALTER TABLE stuck_ride_alerts ADD CONSTRAINT stuck_ride_alerts_reason_check
  CHECK (reason = ANY (ARRAY['complete_blocked'::text, 'stationary_chat'::text, 'dead_driver_app'::text]));

-- ─────────────────────────────────────────────────────────────
-- 3. Transiciones FSM (aditivas)
-- ─────────────────────────────────────────────────────────────
-- El cron corre sin JWT y `enforce_ride_transition` hace early-return cuando
-- auth.uid() IS NULL, así que estrictamente no haría falta. Se agregan igual para
-- que la transición sea legal también si un admin la dispara desde el panel.
INSERT INTO valid_transitions (from_status, to_status, allowed_roles)
SELECT v.from_status::ride_status, 'searching'::ride_status, ARRAY['admin','super_admin']::user_role[]
FROM (VALUES ('accepted'), ('driver_en_route')) AS v(from_status)
WHERE NOT EXISTS (
  SELECT 1 FROM valid_transitions vt
  WHERE vt.from_status = v.from_status::ride_status
    AND vt.to_status = 'searching'::ride_status
);

-- ─────────────────────────────────────────────────────────────
-- 4. La función
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_rides_from_dead_drivers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_after_min   INT;
  v_enabled     TEXT;
  v_released    INT := 0;
  v_flagged     INT := 0;
  v_rider_ids   JSONB := '[]'::jsonb;
  v_service_key TEXT;
  r             RECORD;
BEGIN
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'dead_driver_ride_release_enabled';
  IF v_enabled IN ('false', 'f') THEN
    RETURN jsonb_build_object('enabled', false, 'released', 0, 'flagged', 0);
  END IF;

  -- ::int es obligatorio: get_platform_config_numeric devuelve NUMERIC y
  -- make_interval(mins => ...) solo acepta INT (revienta en runtime, no al crear).
  v_after_min := GREATEST(1, get_platform_config_numeric('dead_driver_ride_release_after_minutes', 12))::int;

  -- ── A) PRE-RECOGIDA → devolver a búsqueda ──────────────────
  FOR r IN
    SELECT rd.id, rd.customer_id, rd.driver_id, rd.status
    FROM rides rd
    JOIN driver_profiles dp ON dp.id = rd.driver_id
    WHERE rd.status IN ('accepted', 'driver_en_route')
      AND dp.last_heartbeat_at IS NOT NULL
      AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  LOOP
    -- Sacar de línea al conductor muerto ANTES de liberar el viaje. Sin esto hay
    -- una carrera: `find_best_drivers` filtra por is_online pero el filtro de
    -- heartbeat está desactivado por defecto (dispatch_heartbeat_window_s = 0),
    -- así que un conductor muerto todavía marcado online podría recibir de vuelta
    -- el mismo viaje que le acabamos de quitar.
    UPDATE driver_profiles
    SET is_online = false, auto_offline_at = COALESCE(auto_offline_at, now())
    WHERE id = r.driver_id AND is_online = true;

    -- searching_seen_at = now() es CRÍTICO: `cleanup_orphan_searching_rides`
    -- (cron cada minuto) cancela los `searching` cuyo searching_seen_at supera
    -- searching_abandon_seconds. Sin refrescarlo, el viaje liberado se cancelaría
    -- al minuto siguiente. Con el refresco arranca una ventana limpia de búsqueda,
    -- y si nadie lo toma, ese mismo cron lo cierra de forma ordenada.
    -- last_dispatched_at = NULL deja que `retry_dispatch_expired_rides` (cada
    -- minuto) lo re-despache de inmediato.
    UPDATE rides
    SET status             = 'searching',
        driver_id          = NULL,
        accepted_at        = NULL,
        searching_seen_at  = now(),
        last_dispatched_at = NULL,
        updated_at         = now()
    WHERE id = r.id
      AND status = r.status;   -- guarda optimista: si el conductor revivió y avanzó, no lo pisamos

    IF FOUND THEN
      v_released := v_released + 1;
      v_rider_ids := v_rider_ids || to_jsonb(r.customer_id);

      -- La oferta del conductor muerto no debe quedar colgada como pendiente.
      UPDATE ride_offers
      SET status = 'expired'
      WHERE ride_id = r.id AND driver_profile_id = r.driver_id AND status = 'pending';
    END IF;
  END LOOP;

  -- ── B) POST-RECOGIDA → solo alertar, jamás tocar el viaje ──
  -- El pasajero puede ir a bordo y el viaje puede estar ocurriendo de verdad con
  -- la app muerta (ride 2fa97a44). Cancelarlo o reasignarlo sería destruir un
  -- viaje real; se marca para revisión humana y nada más.
  INSERT INTO stuck_ride_alerts (ride_id, reason, details)
  SELECT rd.id, 'dead_driver_app',
         jsonb_build_object(
           'ride_status', rd.status,
           'driver_id', rd.driver_id,
           'last_heartbeat_at', dp.last_heartbeat_at,
           'minutes_silent', ROUND(EXTRACT(EPOCH FROM (now() - dp.last_heartbeat_at)) / 60)
         )
  FROM rides rd
  JOIN driver_profiles dp ON dp.id = rd.driver_id
  WHERE rd.status IN ('arrived_at_pickup', 'in_progress', 'arrived_at_destination')
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  ON CONFLICT (ride_id) DO NOTHING;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;

  -- ── C) Avisar a los pasajeros liberados ────────────────────
  -- Bloque propio con su guarda: un fallo de push jamás debe deshacer la liberación.
  IF v_released > 0 THEN
    BEGIN
      v_service_key := get_service_role_key();
      IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
        PERFORM public.cron_http_post('dead-driver-ride-released',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_key,
            'apikey',        v_service_key
          ),
          body    := jsonb_build_object(
            'user_ids', v_rider_ids,
            'title',    'Buscando otro conductor',
            'body',     'Tu conductor perdió la conexión y no pudo continuar. Estamos buscándote otro ahora mismo.',
            'category', 'ride',
            'data',     jsonb_build_object('reason', 'dead_driver_ride_released')
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[release_rides_from_dead_drivers] push failed: % %', SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('enabled', true, 'released', v_released, 'flagged', v_flagged);
END;
$$;

COMMENT ON FUNCTION public.release_rides_from_dead_drivers() IS
  '00542: libera viajes pre-recogida cuyo conductor tiene la app muerta (los devuelve a searching para reasignación) y marca los post-recogida para revisión sin tocarlos. Complementa auto_offline_stale_drivers, que detecta al conductor muerto pero no resuelve su viaje.';

REVOKE ALL ON FUNCTION public.release_rides_from_dead_drivers() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 5. Cron (cada 5 min, igual que auto-offline-stale-drivers)
-- ─────────────────────────────────────────────────────────────
-- Job separado a propósito: si esto fallara, la expulsión de conductores muertos
-- (job 10) sigue funcionando. El orden entre ambos no importa porque el umbral de
-- acá (12 min) es mayor que el de allá (10 min) y la función saca de línea al
-- conductor por su cuenta antes de liberar.
SELECT cron.unschedule('release-dead-driver-rides')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-dead-driver-rides');

SELECT cron.schedule(
  'release-dead-driver-rides',
  '*/5 * * * *',
  $cron$SELECT public.release_rides_from_dead_drivers();$cron$
);
