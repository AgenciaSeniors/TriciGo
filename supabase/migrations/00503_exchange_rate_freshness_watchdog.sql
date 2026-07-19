-- 00503: Watchdog de frescura del tipo de cambio USD/CUP
--
-- CONTEXTO (incidente 2026-07-15 → 2026-07-19)
-- La tasa quedó congelada 4 días y NADIE se enteró hasta que un usuario reportó que no
-- podía recargar. Dos fallos encadenados:
--   1. sync-exchange-rate devolvía 502 all_methods_failed en cada corrida (el parser de la
--      API de elTOQUE nunca soportó la forma escalar {"tasas":{"USD":665.0}}, y el scraper
--      de eltoque.com empezó a recibir 403 de Cloudflare).
--   2. pg_cron NO PUEDE VER ese 502. El job 23 ejecuta `SELECT net.http_post(...)`, que solo
--      ENCOLA y devuelve un request_id. cron.job_run_details registró 91 corridas
--      'succeeded' consecutivas mientras todas fallaban.
--
-- POR QUÉ ESTE WATCHDOG ES SQL PURO Y NO UNA EDGE FUNCTION
-- Una EF invocada por net.http_post heredaría exactamente la misma ceguera: si el watchdog
-- se cayera, el cron seguiría reportando éxito. Acá la DETECCIÓN corre dentro de la base
-- leyendo exchange_rates directo; el único HTTP es el email, que es la ACCIÓN, no la
-- detección. Un fallo de envío no puede ocultar el estado (queda en fx_health_status).
--
-- UMBRAL
-- Las 4 EFs de pago (create-{netopia,stripe}-{payment,recharge}-intent) hardcodean 24h
-- contra created_at y NO leen exchange_rate_max_age_hours. O sea: las recargas se rompen
-- a las 24h exactas, sin importar esa config. Por eso alertamos a las 20h (config
-- fx_stale_alert_hours): deja ~4h de margen para arreglarlo ANTES de que un cliente lo vea.
--
-- Patrón de alerta copiado de proxy-health/index.ts:158-181 (probado en prod):
-- solo notifica en TRANSICIÓN (ok→stale, stale→ok), así que no hace spam horario.

-- ── Umbral de alerta configurable ───────────────────────────────────────────────
INSERT INTO platform_config (key, value)
VALUES ('fx_stale_alert_hours', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.check_exchange_rate_freshness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rate        numeric;
  v_source      text;
  v_fetched     timestamptz;
  v_age_h       numeric;
  v_alert_h     numeric;
  v_status      text;
  v_prev        text;
  v_now         timestamptz := now();
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_age_txt     text;
  v_sent        int := 0;
BEGIN
  SELECT usd_cup_rate, source, fetched_at
    INTO v_rate, v_source, v_fetched
    FROM exchange_rates WHERE is_current = true LIMIT 1;

  SELECT (value #>> '{}')::numeric INTO v_alert_h
    FROM platform_config WHERE key = 'fx_stale_alert_hours';
  v_alert_h := COALESCE(v_alert_h, 20);

  IF v_fetched IS NULL THEN
    v_status  := 'stale';
    v_age_h   := NULL;
    v_age_txt := 'sin fila is_current';
  ELSE
    v_age_h   := round(extract(epoch FROM (v_now - v_fetched)) / 3600.0, 1);
    v_age_txt := v_age_h::text || ' h';
    v_status  := CASE WHEN v_age_h >= v_alert_h THEN 'stale' ELSE 'ok' END;
  END IF;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'fx_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persistir SIEMPRE el estado, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES
    ('fx_health_status', to_jsonb(v_status)),
    ('fx_health_at',     to_jsonb(v_now::text)),
    ('fx_health_detail', to_jsonb(
       COALESCE(v_source, '—') || ' · ' || COALESCE(v_rate::text, '—') || ' CUP · ' || v_age_txt))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- ── Alertar SOLO en transición (de-dup, igual que proxy-health) ──────────────
  IF v_prev IS DISTINCT FROM v_status
     AND (v_status = 'stale' OR (v_status = 'ok' AND v_prev = 'stale')) THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'stale' THEN
        v_subject := '[TriciGo] Tipo de cambio USD/CUP CONGELADO';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Tipo de cambio congelado</h2>'
          || '<p>La tasa USD/CUP tiene <b>' || v_age_txt || '</b> de antigüedad. '
          || '<b>Las recargas dejan de funcionar a las 24 h</b> (las Edge Functions de pago devuelven '
          || '<code>503 fx_unavailable</code> y el usuario ve &laquo;Tipo de cambio USD/CUP no disponible&raquo;).</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tasa actual</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_rate::text, '—') || ' CUP</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fuente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_source, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antigüedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_age_txt || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><b>Qué revisar:</b> los logs de la Edge Function <code>sync-exchange-rate</code>. '
          || 'Si aparece <code>all_methods_failed</code>, fallaron las dos fuentes (API trmi de elTOQUE + scraping de eltoque.com). '
          || 'Si aparece <code>trmi API 200 but USD unparseable</code>, elTOQUE cambió el formato de su respuesta.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automático del tipo de cambio. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] Tipo de cambio USD/CUP recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Tipo de cambio recuperado</h2>'
          || '<p>La tasa USD/CUP volvió a actualizarse. Las recargas funcionan normalmente.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tasa actual</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_rate::text, '—') || ' CUP</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fuente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_source, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Antigüedad</b></td><td style="padding:6px;text-align:right">' || v_age_txt || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automático del tipo de cambio. No responder.</p>'
          || '</body></html>';
      END IF;

      -- business_notification_email puede ser CSV; send-email toma un destinatario por llamada.
      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       -- HTML crudo: send-email lo acepta por el legacy path de resolveTemplate().
                       -- El guardrail solo rechaza slugs pelados (sin tags), así que esto es seguro.
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev, 'age_hours', v_age_h,
    'rate', v_rate, 'source', v_source,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_exchange_rate_freshness failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_exchange_rate_freshness() IS
  '00503: Watchdog de frescura de exchange_rates. Alerta por email en transición ok<->stale. '
  'SQL puro a propósito: detectar vía net.http_post heredaría la ceguera de pg_cron que dejó '
  'el incidente de 2026-07-15 invisible 4 días.';

REVOKE ALL ON FUNCTION public.check_exchange_rate_freshness() FROM PUBLIC, anon, authenticated;

-- ── Cron: minuto 20 de cada hora (20 min después del sync de job 23, que corre en :00) ──
SELECT cron.unschedule('check-exchange-rate-freshness')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-exchange-rate-freshness');

SELECT cron.schedule(
  'check-exchange-rate-freshness',
  '20 * * * *',
  $cron$SELECT public.check_exchange_rate_freshness();$cron$
);
