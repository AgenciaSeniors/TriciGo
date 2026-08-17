-- ============================================================
-- Incidente 2026-08-17 ~13:45-13:50 UTC:
--   auto-admin / sync-exchange-rate / sync-weather empezaron a
--   devolver 401 {"code":"UNAUTHORIZED_LEGACY_JWT","message":"Invalid JWT"}
--   en TODAS sus corridas. pg_cron las seguía reportando 'succeeded'
--   (ver "pg_cron + net.http_post es CIEGO" en CLAUDE.md); solo se
--   vieron por el watchdog de cron_http_calls (00506).
--
-- Causa raíz:
--   Los 4 crons de este archivo mandaban el header
--     Authorization: Bearer <legacy ANON JWT hardcodeado>
--   (el `apikey` sí venía del vault = sb_secret_*, y es el que la EF
--   usa para autorizar de verdad — ver 00219). Ese Bearer era solo
--   para satisfacer el verify_jwt=true del gateway.
--
--   El legacy anon key está `disabled` a nivel proyecto desde
--   BUG-199, pero el gateway de Edge Functions venía GRANDFATHEREANDO
--   los JWT legacy — riesgo que 00219 ya documentó por escrito:
--     "(a) The EF gateway grandfathers legacy-signed JWTs (Supabase
--      quirk; PostgREST already rejects them properly)."
--   El 2026-08-17 Supabase dejó de grandfatherearlos → 401.
--
-- Fix: usar el mismo patrón que los crons que NO se rompieron
--   (probe-netopia-proxy-health, check-sms-balance):
--     'Authorization', 'Bearer ' || get_service_role_key()
--   El vault ya guarda el key en formato nuevo (sb_secret_*), que el
--   gateway sí acepta contra funciones con verify_jwt=true — probado
--   en prod por check-sms-balance (200 con ese patrón, misma hora en
--   que los otros daban 401).
--
-- Los horarios se preservan tal como están VIVOS en prod, que NO
-- coinciden con los de la migración que los creó (sync-exchange-rate
-- pasó de '0 * * * *' a '*/15 * * * *' después de 00219).
-- ============================================================

-- auto-admin ---------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-admin') THEN
    PERFORM cron.unschedule('auto-admin');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-admin',
  '*/5 * * * *',
  $cron$
  SELECT public.cron_http_post('auto-admin',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/auto-admin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- sync-exchange-rate -------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-exchange-rate') THEN
    PERFORM cron.unschedule('sync-exchange-rate');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-exchange-rate',
  '*/15 * * * *',
  $cron$
  SELECT public.cron_http_post('sync-exchange-rate',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-exchange-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- sync-weather -------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-weather') THEN
    PERFORM cron.unschedule('sync-weather');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-weather',
  '*/15 * * * *',
  $cron$
  SELECT public.cron_http_post('sync-weather',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-weather',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- behavioral-emails-daily --------------------------------------
-- No falló todavía porque corre 08:00 UTC (su próxima corrida es
-- después del corte). Tenía el mismo Bearer legacy → habría dado 401.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'behavioral-emails-daily') THEN
    PERFORM cron.unschedule('behavioral-emails-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'behavioral-emails-daily',
  '0 8 * * *',
  $cron$
  SELECT public.cron_http_post('behavioral-emails-daily',
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/behavioral-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_service_role_key(),
      'apikey', get_service_role_key()
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- Verificación al aplicar: ningún cron puede quedar con un JWT
-- hardcodeado. Falla ruidosamente en vez de dejar otro cron ciego.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(jobname, ', ' ORDER BY jobname) INTO v_left
  FROM cron.job WHERE command LIKE '%eyJ%';

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'Crons con JWT hardcodeado todavía presentes: %', v_left;
  END IF;

  RAISE NOTICE '00567: 4 crons migrados a get_service_role_key(); 0 JWT hardcodeados restantes';
END $$;
