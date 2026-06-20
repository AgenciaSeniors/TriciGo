-- 00451_rereview_hardening_scheduling_and_cancel_flag.sql
-- Auditoría 2026-06-20, SEGUNDA FASE (verificación). Hallazgos de la re-revisión adversarial de las
-- migraciones que no la tuvieron en la 1ra pasada.
--
-- (1) **SECURITY — lock bypass introducido por 00448 (P1/P2).** El carve-out de 00448 excluye del
--     lock de un-viaje-activo a los rides con (is_scheduled=true AND NOT scheduled_notified). Pero
--     `is_scheduled`/`scheduled_notified` son ESCRIBIBLES por el cliente (la RLS de INSERT de rides
--     solo chequea customer_id=auth.uid(); ningún BEFORE INSERT los sanitiza). Verificado contra prod:
--     un cliente puede INSERTar un ride NORMAL con is_scheduled=true, scheduled_notified=false,
--     scheduled_at=NULL → queda excluido del lock Y `on_ride_insert_dispatch` lo despacha igual
--     (condición `scheduled_at IS NULL`) → el cliente obtiene múltiples viajes activos/despachados.
--     Fix: forzar server-side en cada INSERT que un ride es "scheduled" SOLO si trae un scheduled_at
--     futuro real, y scheduled_notified siempre false al crear (solo el cron de activación lo pone
--     true, vía UPDATE). Correcto para los paths normal / scheduled / recurring por igual.
--
-- (2) **Robustez — activate_scheduled_rides sin EXCEPTION por-fila (P2).** Si al activar un ride
--     (flip scheduled_notified=true) el cliente ya tiene otro ride activo, el UPDATE choca con el
--     índice único y aborta TODO el batch (ningún scheduled se activa esa corrida). Patrón de
--     create_rides_for_recurring (00435): envolver cada iteración en BEGIN/EXCEPTION.
--
-- (3) **Hygiene — cancel_ride no limpia app.trusted_cancel_update (LOW).** Inerte hoy (no hay un 2º
--     UPDATE users), pero el patrón de trusted_tier_update SÍ lo limpia. Lo limpiamos tras el counter
--     UPDATE para que un futuro UPDATE users en cancel_ride no herede confianza por accidente.

-- ─────────────────────────────────────────────────────────────────────────
-- (1) Sanitizar is_scheduled / scheduled_notified server-side (BEFORE INSERT).
--     El nombre del trigger ("rides_*") ordena ANTES de "trg_enforce_one_active_ride_per_customer",
--     así el lock ve el valor ya normalizado.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_normalize_scheduling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Un ride es "scheduled" solo si lleva un scheduled_at futuro real; scheduled_notified es siempre
  -- false al crear (el cron activate_scheduled_rides lo pone true vía UPDATE, no INSERT). Esto cierra
  -- el bypass del lock: un cliente no puede marcar un ride normal como pending-scheduled.
  NEW.is_scheduled := (NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now());
  NEW.scheduled_notified := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rides_normalize_scheduling ON public.rides;
CREATE TRIGGER rides_normalize_scheduling
  BEFORE INSERT ON public.rides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_rides_normalize_scheduling();

-- ─────────────────────────────────────────────────────────────────────────
-- (2) activate_scheduled_rides: EXCEPTION por-fila (reproducido del cuerpo vivo + el wrap).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activate_scheduled_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_activated INTEGER := 0;
BEGIN
  FOR v_ride IN
    SELECT r.id
    FROM rides r
    WHERE r.is_scheduled = true
      AND r.scheduled_notified = false
      AND r.status = 'searching'
      AND r.scheduled_at IS NOT NULL
      AND r.scheduled_at <= NOW() + interval '10 minutes'
      AND r.scheduled_at >  NOW() - interval '15 minutes'
  LOOP
    BEGIN
      UPDATE rides SET scheduled_notified = true WHERE id = v_ride.id;
      PERFORM dispatch_ride(v_ride.id);
      v_activated := v_activated + 1;
    EXCEPTION WHEN OTHERS THEN
      -- p.ej. el cliente ya tiene otro ride activo → conflicto con el índice único. No abortar el
      -- batch: dejar este ride pending (se reintenta el próximo tick / cuando se libere el otro).
      RAISE WARNING 'activate_scheduled_rides: ride % no activado (%) — queda pending, reintenta', v_ride.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_activated;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- (3) cancel_ride: limpiar el trust flag tras el counter UPDATE (patch-in-place idempotente).
-- ─────────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
  FROM pg_proc p WHERE p.proname = 'cancel_ride' AND p.pronamespace = 'public'::regnamespace
  LIMIT 1;

  IF v_src IS NULL THEN
    RAISE NOTICE 'cancel_ride absent; skipping';
    RETURN;
  END IF;

  IF position('''app.trusted_cancel_update'', ''off''' IN v_src) > 0 THEN
    RAISE NOTICE 'cancel_ride already clears the flag; skipping';
    RETURN;
  END IF;

  v_src := replace(
    v_src,
    E'SET cancellation_count = COALESCE(cancellation_count, 0) + 1,\n           last_cancellation_at = now()\n     WHERE id = v_canceled_by;',
    E'SET cancellation_count = COALESCE(cancellation_count, 0) + 1,\n           last_cancellation_at = now()\n     WHERE id = v_canceled_by;\n    PERFORM set_config(''app.trusted_cancel_update'', ''off'', true);'
  );

  IF position('''app.trusted_cancel_update'', ''off''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'cancel_ride flag-clear patch did not match — aborting (manual review needed)';
  END IF;

  EXECUTE v_src;
  RAISE NOTICE 'cancel_ride patched: clears app.trusted_cancel_update after the counter UPDATE';
END $patch$;
