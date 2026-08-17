-- 00567: Los 4 crons con JWT legacy hardcodeado → autenticar desde el vault
--
-- INCIDENTE (2026-08-17, ~13:45 UTC). Los crons 22 (auto-admin), 23
-- (sync-exchange-rate), 24 (sync-weather) y 25 (behavioral-emails-daily)
-- empezaron a fallar en cada corrida con 401 {"code":"UNAUTHORIZED_LEGACY_JWT"}.
-- Lo detectó check_cron_http_failures() (00506/00507) en menos de una hora.
--
-- CAUSA RAÍZ. Esos 4 comandos — los más viejos del proyecto — llevan el JWT
-- legacy ANON incrustado como literal en el header Authorization (el mismo key
-- que el dashboard lista como disabled). El gateway lo toleró durante meses
-- porque el apikey traía el service-role del vault; el 17-ago dejó de aceptar
-- JWTs legacy en el Bearer y los 4 murieron a la vez. Es la clase documentada
-- en CLAUDE.md como "renombraron pero quedó el caller viejo": la migración de
-- claves pasó todo al vault y nadie actualizó los comandos que ya estaban.
--
-- POR QUÉ ESTE FIX ES EL CORRECTO (verificado, no supuesto): los crons hermanos
-- 33/34/35/44 autentican con get_service_role_key() (vault, formato sb_) contra
-- Edge Functions verify_jwt=true y devuelven 200 hoy mismo — check-sms-balance
-- 200 a las 12:17, driver-offline-notice 200 a las 15:00. Se replica ese patrón
-- exacto. Cero funciones de la DB tienen JWTs incrustados (barrido de pg_proc:
-- 0 filas con 'eyJ') — el problema son SOLO estos 4 comandos.
--
-- IMPACTO SI NO SE APLICA: sync-exchange-rate congelado → a las 24 h las
-- recargas devuelven 503 fx_unavailable (fail-closed conocido); auto-admin y
-- sync-weather muertos; behavioral-emails fallaría a las 08:00.
--
-- Idempotente: solo reescribe el comando si TODAVÍA contiene un JWT incrustado
-- ('eyJ'), así que re-correrla no pisa ediciones futuras.

DO $fix$
DECLARE
  v_job RECORD;
  v_new text;
BEGIN
  FOR v_job IN
    SELECT jobid, jobname, command FROM cron.job
    WHERE jobname IN ('auto-admin','sync-exchange-rate','sync-weather','behavioral-emails-daily')
      AND command LIKE '%eyJ%'
  LOOP
    -- Reemplaza SOLO el literal del Bearer por la lectura dinámica del vault,
    -- conservando URL, body y el resto del comando byte a byte.
    v_new := regexp_replace(
      v_job.command,
      $re$'Authorization', 'Bearer eyJ[^']*'$re$,
      $sub$'Authorization', 'Bearer ' || get_service_role_key()$sub$
    );

    IF v_new = v_job.command THEN
      RAISE WARNING '00567: % no matcheó el patrón — revisar a mano', v_job.jobname;
      CONTINUE;
    END IF;

    PERFORM cron.alter_job(v_job.jobid, command := v_new);
    RAISE NOTICE '00567: % (job %) migrado a auth por vault', v_job.jobname, v_job.jobid;
  END LOOP;
END $fix$;
