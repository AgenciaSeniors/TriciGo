-- 00540: Auto-restauración de conductores desconectados por el cron
--
-- PROBLEMA MEDIDO (48 h de audit_log, 2026-08-02)
-- El cron `auto-offline-stale-drivers` desconectó 118 veces. El 41% de esas
-- veces el conductor volvió a latir dentro de los 20 min: su app estaba viva,
-- solo se le habían congelado los timers (Android suspende el JS). Pero
-- `driver_heartbeat()` únicamente escribía `last_heartbeat_at` y NUNCA devolvía
-- `is_online = true`, así que el conductor quedaba ZOMBI: creyéndose en turno,
-- mandando GPS, e invisible para el matching hasta que tocara el switch a mano.
--
-- Costo real verificado (Charles Valdés, b39c9c86):
--   31/07 19:45:00  el cron lo saca      → is_online=false
--   31/07 19:45:40  su app vuelve a latir → sigue is_online=false
--   31/07 19:46:48  entra un triciclo a 4.7 km → 0 ofertas a NADIE
--   31/07 19:59     el pasajero abandona la búsqueda
-- Mismo patrón el 01/08 16:13. En 9 días recibió 1 sola oferta.
--
-- POR QUÉ NO ALCANZA CON "si late, ponelo online" (descartado con datos)
-- El latido NO prueba que quiera trabajar: `useDriverRide.ts` late en cada
-- AppState→active sin mirar el turno, y el apagado del foreground service
-- tiene fuga. Medido: de 77 desconexiones MANUALES, 24 siguieron latiendo
-- (31%) y 17 lo hicieron pasados 5 min (22%); 3 de 17 hasta siguieron
-- mandando GPS. Restaurar por latido a secas pondría en línea contra su
-- voluntad a ~1 de cada 4 que se desconectan a propósito.
--
-- DISEÑO: marca de intención + restauración acotada y aislada.
--   - Solo se restaura lo que apagó el CRON (marca `auto_offline_at`).
--   - Cualquier cambio de `is_online` hecho por una persona (auth.uid()
--     presente: el propio conductor o un admin) BORRA la marca → una
--     desconexión manual jamás se revierte sola, aunque la app siga latiendo.
--   - Ventana acotada (`driver_auto_restore_window_min`, def. 60): pasada esa,
--     hay que reconectarse a mano. Evita resucitar al que terminó su turno
--     matando la app y abre la app al otro día.
--
-- SEGURIDAD DEL HEARTBEAT (lo más importante de esta migración)
-- `tg_driver_profiles_protect_admin_fields` LANZA EXCEPCIÓN si is_online pasa
-- a true sin vehículo activo o sin estar aprobado, y `auth.uid()` sigue siendo
-- el conductor dentro de este SECURITY DEFINER. Si la restauración fuera parte
-- del mismo UPDATE del latido, esos conductores dejarían de latir por completo
-- → el cron los sacaría → desastre. Por eso:
--   1. El latido se escribe SIEMPRE primero, en su propio UPDATE.
--   2. La restauración va en un bloque aparte, con las mismas precondiciones
--      del trigger (aprobado + vehículo activo) Y envuelta en EXCEPTION.
-- El latido no puede fallar por culpa de esta feature.
--
-- Efectos deseados al restaurar (triggers ya existentes):
--   - trg_dispatch_on_driver_online → le despacha los viajes en búsqueda YA.
--   - trg_manage_driver_work_session → reabre su sesión de trabajo.

ALTER TABLE public.driver_profiles
  ADD COLUMN IF NOT EXISTS auto_offline_at timestamptz;

COMMENT ON COLUMN public.driver_profiles.auto_offline_at IS
  '00540: cuándo el cron auto_offline_stale_drivers lo sacó de línea. NULL = la '
  'última desconexión fue intencional (o ya se restauró). Solo se auto-restaura si NO es NULL.';

CREATE INDEX IF NOT EXISTS idx_driver_profiles_auto_offline
  ON public.driver_profiles (auto_offline_at) WHERE auto_offline_at IS NOT NULL;

INSERT INTO platform_config (key, value) VALUES
  ('driver_auto_restore_enabled',    to_jsonb(true)),
  ('driver_auto_restore_window_min', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;

-- ── 1) Marca de intención: una persona que toca el switch manda ─────────────
CREATE OR REPLACE FUNCTION public.tg_driver_profiles_shift_intent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- auth.uid() presente = lo hizo una persona (el conductor o un admin), no el
  -- cron (service_role, auth.uid() NULL). Su intención manda: se borra la marca.
  IF NEW.is_online IS DISTINCT FROM OLD.is_online AND auth.uid() IS NOT NULL THEN
    NEW.auto_offline_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_profiles_shift_intent ON public.driver_profiles;
CREATE TRIGGER trg_driver_profiles_shift_intent
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_profiles_shift_intent();

-- ── 2) El cron deja la marca al desconectar ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_offline_stale_drivers()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_after_min   INT;
  v_user_ids    JSONB;
  v_count       INT := 0;
  v_enabled     TEXT;
  v_service_key TEXT;
BEGIN
  v_after_min := GREATEST(1, get_platform_config_numeric('driver_offline_after_minutes', 10))::int;

  WITH stale AS (
    UPDATE driver_profiles dp
    SET is_online = false,
        -- 00540: marca para la auto-restauración. Solo la pone el cron.
        auto_offline_at = now()
    WHERE dp.is_online = true
      AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
    RETURNING dp.user_id
  )
  SELECT COALESCE(jsonb_agg(user_id), '[]'::jsonb), COUNT(*)
    INTO v_user_ids, v_count
  FROM stale;

  IF v_count = 0 THEN
    RETURN 0;
  END IF;

  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'driver_offline_notice_enabled';
  IF v_enabled IN ('false', 'f') THEN
    RETURN v_count;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN v_count;
  END IF;

  BEGIN
    PERFORM public.cron_http_post('driver-offline-notice',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey',        v_service_key
      ),
      body    := jsonb_build_object(
        'user_ids', v_user_ids,
        'title',    'Quedaste fuera de línea',
        -- 00540: tuteo neutro cubano (el voseo entró por copia; ver PR #919).
        'body',     'Tu app dejó de reportar tu ubicación, así que dejaste de recibir viajes. Abre TriciGo Conductor y vuelve a conectarte.',
        'category', 'system',
        'data', jsonb_build_object('reason', 'stale_heartbeat_auto_offline')
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[auto_offline_stale_drivers] notice failed: % %', SQLSTATE, SQLERRM;
  END;

  RETURN v_count;
END;
$function$;

-- ── 3) El latido restaura, sin poder romperse nunca ─────────────────────────
CREATE OR REPLACE FUNCTION public.driver_heartbeat(p_driver_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_min numeric;
  v_enabled    text;
BEGIN
  IF NOT (
    is_admin()
    OR auth.uid() = (SELECT user_id FROM driver_profiles WHERE id = p_driver_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden: cannot refresh another driver''s heartbeat';
  END IF;

  -- (1) El latido, siempre y primero. Es el contrato de esta función.
  UPDATE driver_profiles
  SET last_heartbeat_at = NOW()
  WHERE id = p_driver_id;

  -- (2) Restauración, aislada: si algo falla acá, el latido YA quedó escrito.
  BEGIN
    SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
    FROM platform_config WHERE key = 'driver_auto_restore_enabled';
    IF v_enabled IN ('false', 'f') THEN
      RETURN;
    END IF;

    v_window_min := COALESCE(get_platform_config_numeric('driver_auto_restore_window_min', 60), 60);

    UPDATE driver_profiles dp
    SET is_online = true
    WHERE dp.id = p_driver_id
      AND dp.is_online = false
      -- Solo lo que apagó el cron; una desconexión manual borró la marca.
      AND dp.auto_offline_at IS NOT NULL
      AND dp.auto_offline_at > now() - make_interval(mins => v_window_min::int)
      -- Precondiciones de tg_driver_profiles_protect_admin_fields: sin esto el
      -- trigger lanzaría excepción y mataría el latido.
      AND dp.status = 'approved'
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = dp.id AND v.is_active = true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[driver_heartbeat] auto-restore failed for %: % %', p_driver_id, SQLSTATE, SQLERRM;
  END;
END;
$function$;

COMMENT ON FUNCTION public.driver_heartbeat(uuid) IS
  '00540: además del latido, devuelve a línea al conductor que sacó el cron '
  '(auto_offline_at) dentro de la ventana configurada. La restauración va aislada: '
  'el latido nunca puede fallar por su culpa.';
