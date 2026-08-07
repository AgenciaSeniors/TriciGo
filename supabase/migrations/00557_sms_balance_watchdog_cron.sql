-- 00557: Cron del watchdog de saldo SMS (D7)
--
-- Acompaña a la Edge Function check-sms-balance. Ver el encabezado de
-- supabase/functions/check-sms-balance/index.ts para el contexto completo del
-- incidente 2026-08-06 (saldo D7 agotado → 31 h sin login por teléfono).
--
-- RELACIÓN CON 00556 — complementarios, no redundantes:
--   • 00556 detecta el apagón ~6 h DESPUÉS, por cualquier causa (token revocado,
--     ruta bloqueada, red, caída de D7). Mira el efecto.
--   • Esto PREVIENE el modo de falla más común — quedarse sin saldo — avisando
--     con ~11 días de anticipación al consumo actual. Mira la causa.
--
-- UMBRAL ELEGIDO CON DATOS (medido 2026-08-07 sobre sms_deliveries):
--   promedio 7 días  : 23,7 SMS/día  (~$1,66/día a ~$0.07 por SMS a Cuba)
--   promedio 30 días : 26,0 SMS/día  (~$1,82/día)
--   pico diario      : 113 SMS       (~$7,91)
-- $20 ⇒ ~11 días de aviso al ritmo promedio y ~2,5 días aun en un día pico.
-- Editable sin redeploy en platform_config.sms_balance_alert_usd.
--
-- POR QUÉ cron_http_post Y NO net.http_post CRUDO
-- Regla dura del proyecto (CLAUDE.md): todo cron que llame a una Edge Function
-- debe pasar por public.cron_http_post, porque pg_cron NO VE el resultado HTTP —
-- job_run_details registra el éxito del ENCOLADO, no el de la función. Con el
-- wrapper, check_cron_http_failures() (00506/00507) alerta si esta comprobación
-- deja de devolver 2xx. Eso cubre el caso "el vigilante se murió y nadie se entera":
-- la EF devuelve 503 si falta D7_API_TOKEN y 502 si D7 no responde o rechaza el
-- token (401), así que una credencial rota sale por el canal de fallos del cron.
--
-- Cada 6 h alcanza de sobra: con el umbral en $20 quedan ~2,5 días de margen
-- incluso en el peor día medido, y el saldo se mueve despacio.

INSERT INTO platform_config (key, value)
VALUES ('sms_balance_alert_usd', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

SELECT cron.unschedule('check-sms-balance')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-sms-balance');

SELECT cron.schedule(
  'check-sms-balance',
  '17 */6 * * *',
  $cron$
  SELECT public.cron_http_post('check-sms-balance',
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/check-sms-balance',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || get_service_role_key(),
                 'apikey', get_service_role_key()),
    body    := '{}'::jsonb);
  $cron$
);
