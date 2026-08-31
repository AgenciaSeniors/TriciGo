-- 00576 — Cortar el crecimiento sin techo de audit_log y cron.job_run_details
--
-- CONTEXTO (medido en prod 2026-08-31, después de que el dueño tuviera que
-- reiniciar la base porque colapsó):
--
--   base completa                2141 MB
--   audit_log                    1178 MB  (55 % de la base)  +4.870 filas/día
--   cron.job_run_details          306 MB                     +5.482 filas/día
--   -------------------------------------------------------------------------
--   esas dos tablas              1484 MB  = 69 % de la base, ~15,7 MB/día
--
-- Hay OCHO crons de limpieza (otp_codes, rpc_attempt_log, notifications,
-- ride_location_events, auth_revocations, viajes viejos...) y NINGUNO toca
-- estas dos. Son las únicas dos tablas del proyecto que crecen sin techo.
--
-- POR QUÉ audit_log es tan grande. De sus 413.691 filas, 408.842 (98,8 %) son
-- de driver_profiles: los LATIDOS de GPS del conductor. Cada latido es un
-- UPDATE, y record_audit() guarda el perfil entero DOS veces (old_values +
-- new_values en jsonb) → ~2,8 KB por latido. Desglose de las 45.700 filas de
-- driver_profiles de los últimos 7 días, por conjunto de columnas que cambian:
--
--   last_heartbeat_at                 24.363   53,3 %   telemetría
--   current_heading, current_location 18.774   41,1 %   telemetría
--   (ninguna: UPDATE que no cambió nada) 1.822   4,0 %   ruido puro
--   auto_offline_at, is_online            418   0,9 %   <- SEÑAL, se conserva
--   current_location                      128   0,3 %   telemetría
--   is_online                              86   0,2 %   <- SEÑAL, se conserva
--   resto (status, approved_at, ...)      ~109   0,2 %   <- SEÑAL, se conserva
--
-- O sea: 98,7 % es telemetría y 1,3 % es información real.
--
-- QUÉ NO SE PIERDE. CLAUDE.md documenta audit_log como LA herramienta para
-- distinguir una desconexión FORZADA (`changed_by IS NULL` = la hizo el cron)
-- de una manual, y esa investigación sigue abierta. Esas filas son justamente
-- las de `is_online` / `auto_offline_at`, que quedan intactas y completas.
--
-- Lo que sí se dejaría de poder reconstruir es el HISTORIAL de latidos ("el
-- latido se cortó en seco a las 14:32"), que hoy solo vive acá. Por eso los
-- latidos no se tiran: se mueven a driver_heartbeat_log, tres columnas sin
-- jsonb, ~50 bytes por fila en vez de 2.800. Misma capacidad de diagnóstico
-- al 2 % del costo.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Rastro fino de latidos (reemplaza al que hoy vive dentro de audit_log)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.driver_heartbeat_log (
  driver_profile_id uuid        NOT NULL,
  beat_at           timestamptz NOT NULL,
  is_online         boolean
);

-- Sin PK ni columna id a propósito: es un rastro append-only y cada byte
-- ahorrado se multiplica por ~7.000 filas/día.
-- BRIN para el purgado por rango de tiempo (la tabla se escribe en orden
-- cronológico, que es exactamente el caso donde BRIN gana): ~30 KB en vez de
-- los ~15 MB que costaría un btree sobre beat_at.
CREATE INDEX IF NOT EXISTS idx_driver_heartbeat_log_beat_at
  ON public.driver_heartbeat_log USING brin (beat_at);
-- Para "mostrame los latidos del conductor X" (el uso forense real).
CREATE INDEX IF NOT EXISTS idx_driver_heartbeat_log_driver
  ON public.driver_heartbeat_log (driver_profile_id, beat_at DESC);

-- Tabla-candado: RLS activa y CERO policies. Solo la escribe record_audit()
-- (SECURITY DEFINER) y solo la leen service_role/admin por SQL. Mismo patrón
-- que otp_codes y rate_limits; el advisor `rls_enabled_no_policy` la va a
-- listar y es intencional (ver CLAUDE.md § sweep de contrato).
ALTER TABLE public.driver_heartbeat_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.driver_heartbeat_log IS
  '00576: rastro fino de latidos de GPS del conductor. Reemplaza a las filas de '
  'telemetría que antes iban a audit_log a ~2,8 KB cada una. Retención corta '
  '(driver_heartbeat_retention_days). Sirve para reconstruir "cuándo se cortó el '
  'latido" sin inflar la base.';

-- ════════════════════════════════════════════════════════════════════════
-- 2. record_audit(): los latidos dejan de entrar a audit_log
-- ════════════════════════════════════════════════════════════════════════
--
-- La función es COMPARTIDA por 5 triggers (driver_profiles, payment_intents,
-- rides, users, wallet_accounts). El corto-circuito está acotado con
-- TG_TABLE_NAME = 'driver_profiles' a propósito: es la única tabla donde se
-- midió el problema, y así las otras cuatro quedan byte por byte como estaban.
--
-- El criterio NO es una lista de columnas "a ignorar" evaluada de a una, sino
-- comparar la fila ENTERA menos la telemetría. Si lo que queda es idéntico,
-- entonces lo único que cambió fue telemetría (o nada) y la fila no aporta.
-- Cualquier cambio real — is_online, status, saldo, lo que sea — hace que los
-- restos difieran y la fila se audita completa, como siempre.

CREATE OR REPLACE FUNCTION public.record_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- updated_at entra en la lista porque acompaña a CUALQUIER cambio: si además
  -- cambió algo real, ese algo real ya hace que los restos difieran.
  c_telemetry CONSTANT text[] :=
    ARRAY['last_heartbeat_at', 'current_location', 'current_heading', 'updated_at'];
BEGIN
  IF TG_TABLE_NAME = 'driver_profiles' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - c_telemetry) IS NOT DISTINCT FROM (to_jsonb(NEW) - c_telemetry) THEN
      -- Solo telemetría. Rastro fino y afuera.
      IF NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at THEN
        INSERT INTO driver_heartbeat_log (driver_profile_id, beat_at, is_online)
        VALUES (NEW.id, NEW.last_heartbeat_at, NEW.is_online);
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_log (table_name, record_id, operation, old_values, new_values, changed_by)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    TG_OP,
    CASE WHEN TG_OP IN ('DELETE', 'UPDATE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Defensivo, igual que antes: auditar nunca puede tumbar la escritura real.
  RAISE WARNING 'record_audit failed for %.%: % %',
    TG_TABLE_NAME, COALESCE(NEW.id::TEXT, OLD.id::TEXT), SQLSTATE, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.record_audit() IS
  '00576: audita cambios en 5 tablas. En driver_profiles saltea los UPDATE que '
  'solo tocan telemetría (latido/ubicación/rumbo) — el 98,7 % del volumen — y '
  'deja rastro fino en driver_heartbeat_log. Los cambios de is_online / '
  'auto_offline_at / status se siguen auditando enteros.';

-- ════════════════════════════════════════════════════════════════════════
-- 3. Retención
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO platform_config (key, value) VALUES
  ('audit_log_retention_days',           to_jsonb(90)),
  ('audit_log_telemetry_retention_days', to_jsonb(14)),
  ('audit_log_prune_batch',              to_jsonb(20000)),
  ('driver_heartbeat_retention_days',    to_jsonb(30)),
  ('cron_run_details_retention_days',    to_jsonb(14)),
  ('cron_run_details_prune_batch',       to_jsonb(50000))
ON CONFLICT (key) DO NOTHING;

-- Purgado de audit_log. DOS reglas, porque el atraso histórico NO lo resuelve
-- la retención general: el bulto arranca el 2026-06-07, o sea que TODO entra
-- cómodo dentro de los 90 días.
--
-- Va POR TANDAS a propósito. Un DELETE único de 400k filas sobre una tabla de
-- 1,1 GB genera ~1,1 GB de WAL de un saque en una instancia chica
-- (max_connections=60, shared_buffers=224 MB) — o sea, el mismo tipo de
-- presión que ya tumbó la base una vez. A 20.000 filas por corrida horaria el
-- atraso se drena en menos de un día sin un solo pico.
CREATE OR REPLACE FUNCTION public.prune_audit_log()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_telemetry CONSTANT text[] :=
    ARRAY['last_heartbeat_at', 'current_location', 'current_heading', 'updated_at'];
  -- ::int obligatorio: get_platform_config_numeric devuelve NUMERIC y
  -- make_interval solo acepta INT en days (ver CLAUDE.md, trampa de 00527).
  v_keep_days     int := COALESCE(get_platform_config_numeric('audit_log_retention_days', 90), 90)::int;
  v_keep_tel_days int := COALESCE(get_platform_config_numeric('audit_log_telemetry_retention_days', 14), 14)::int;
  v_batch         int := COALESCE(get_platform_config_numeric('audit_log_prune_batch', 20000), 20000)::int;
  v_old int := 0;
  v_tel int := 0;
BEGIN
  -- (a) Retención general: cualquier fila más vieja que v_keep_days.
  DELETE FROM audit_log WHERE ctid IN (
    SELECT a.ctid FROM audit_log a
    WHERE a.created_at < now() - make_interval(days => v_keep_days)
    LIMIT v_batch);
  GET DIAGNOSTICS v_old = ROW_COUNT;

  -- (b) Telemetría histórica de driver_profiles (el atraso de 1,1 GB). Mismo
  --     criterio que el corto-circuito de record_audit(), aplicado hacia atrás.
  --     Usa idx_audit_log_table (table_name, created_at DESC) — no hace falta
  --     índice nuevo sobre una tabla de este tamaño.
  DELETE FROM audit_log WHERE ctid IN (
    SELECT a.ctid FROM audit_log a
    WHERE a.table_name = 'driver_profiles'
      AND a.operation  = 'UPDATE'
      AND a.created_at < now() - make_interval(days => v_keep_tel_days)
      AND (a.old_values - c_telemetry) IS NOT DISTINCT FROM (a.new_values - c_telemetry)
    LIMIT v_batch);
  GET DIAGNOSTICS v_tel = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_retention', v_old,
    'deleted_telemetry', v_tel,
    'retention_days', v_keep_days,
    'telemetry_retention_days', v_keep_tel_days,
    'batch', v_batch,
    'remaining_rows', (SELECT count(*) FROM audit_log));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_audit_log failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

CREATE OR REPLACE FUNCTION public.prune_driver_heartbeat_log()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_keep int := COALESCE(get_platform_config_numeric('driver_heartbeat_retention_days', 30), 30)::int;
  v_n    int := 0;
BEGIN
  DELETE FROM driver_heartbeat_log WHERE beat_at < now() - make_interval(days => v_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_n, 'retention_days', v_keep);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_driver_heartbeat_log failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

-- cron.job_run_details: 951.450 filas / 306 MB acumuladas desde el 2026-03-10.
-- pg_cron NO purga solo; con 30 jobs (varios cada minuto) suma 5.482 filas/día.
-- También por tandas, por el mismo motivo que audit_log.
CREATE OR REPLACE FUNCTION public.prune_cron_job_run_details()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_keep  int := COALESCE(get_platform_config_numeric('cron_run_details_retention_days', 14), 14)::int;
  v_batch int := COALESCE(get_platform_config_numeric('cron_run_details_prune_batch', 50000), 50000)::int;
  v_n     int := 0;
BEGIN
  DELETE FROM cron.job_run_details WHERE ctid IN (
    SELECT d.ctid FROM cron.job_run_details d
    WHERE d.start_time < now() - make_interval(days => v_keep)
    LIMIT v_batch);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_n, 'retention_days', v_keep, 'batch', v_batch);
EXCEPTION WHEN OTHERS THEN
  -- Si el rol dueño de la función no puede borrar del schema cron, esto avisa
  -- en vez de dejar el cron en rojo para siempre.
  RAISE WARNING 'prune_cron_job_run_details failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_audit_log()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_driver_heartbeat_log()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_cron_job_run_details()   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_audit_log()            TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_driver_heartbeat_log() TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_cron_job_run_details() TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Crons
-- ════════════════════════════════════════════════════════════════════════
-- Horarios: los prune existentes se juntan entre 03:00 y 04:30. Estos van
-- HORARIOS (no diarios) para drenar el atraso en menos de un día, y en minutos
-- libres para no pisar a los watchdogs de :20, :40 y :50.

SELECT cron.unschedule('prune-audit-log')             WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='prune-audit-log');
SELECT cron.unschedule('prune-driver-heartbeat-log')  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='prune-driver-heartbeat-log');
SELECT cron.unschedule('prune-cron-run-details')      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='prune-cron-run-details');

SELECT cron.schedule('prune-audit-log',            '25 * * * *', 'SELECT public.prune_audit_log();');
SELECT cron.schedule('prune-cron-run-details',     '35 * * * *', 'SELECT public.prune_cron_job_run_details();');
SELECT cron.schedule('prune-driver-heartbeat-log', '45 5 * * *', 'SELECT public.prune_driver_heartbeat_log();');

-- ════════════════════════════════════════════════════════════════════════
-- NOTA SOBRE EL ESPACIO EN DISCO — leer antes de esperar que baje el tamaño
-- ════════════════════════════════════════════════════════════════════════
-- Un DELETE marca las filas como muertas; NO devuelve el espacio al sistema
-- operativo. Después de que los crons drenen el atraso, audit_log va a seguir
-- ocupando ~1,1 GB, pero como espacio REUTILIZABLE: deja de crecer, que es el
-- 90 % del objetivo y es lo que evita el próximo colapso.
--
-- Para recuperar ese 1,1 GB de verdad hace falta, A MANO y con la app en
-- horario de bajo tráfico:
--
--   VACUUM (FULL, ANALYZE) public.audit_log;
--
-- VACUUM FULL toma un ACCESS EXCLUSIVE LOCK sobre la tabla. Mientras dura
-- (~1-2 min a este tamaño) CUALQUIER escritura en driver_profiles, rides,
-- users, wallet_accounts o payment_intents se BLOQUEA, porque sus triggers de
-- auditoría escriben acá. O sea: la app se frena mientras corre. Por eso NO se
-- automatiza en esta migración — es una decisión operativa, no un cron.
