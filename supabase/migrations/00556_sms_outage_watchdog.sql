-- 00556: Watchdog de apagón total de SMS (D7)
--
-- CONTEXTO (incidente 2026-08-06 → 2026-08-07)
-- D7 dejó de aceptar envíos a las 2026-08-06 15:34 UTC y NADIE se enteró durante
-- 31 horas, hasta que los conductores reportaron "Algo salió mal" al iniciar sesión.
-- El SMS gatea TODOS los logins por teléfono (send-sms-otp), el vínculo de teléfono
-- (link-phone), el link de viaje a contactos de confianza (send-sms), las campañas
-- (send-bulk-sms) y el SOS de emergencia (broadcast-emergency) — los cinco comparten
-- _shared/d7.ts. Era el único subsistema crítico sin watchdog: el tipo de cambio tiene
-- el suyo (00503), los crons→EF el suyo (00506/00507) y el proxy NETOPIA el suyo.
--
-- POR QUÉ ESTE WATCHDOG ES SQL PURO Y NO UNA EDGE FUNCTION
-- Misma razón que 00503: una EF invocada por net.http_post heredaría la ceguera de
-- pg_cron (job_run_details registra el éxito del encolado, no el del HTTP). Acá la
-- DETECCIÓN corre dentro de la base leyendo rate_limits; el único HTTP es el email,
-- que es la ACCIÓN, no la detección. Si el envío falla, el estado igual queda
-- persistido en platform_config.sms_health_status.
--
-- ── LA SEÑAL (y por qué NO es "hace N horas que no sale un SMS") ──────────────────
-- El SMS es dirigido por demanda: de madrugada no sale ninguno y eso es SANO. Medido
-- sobre 1438 horas de historia (2026-06-08 → 2026-08-07), la regla ingenua
-- "≥3 intentos y 0 entregas en 6 h" dio 44 falsos positivos, y "≥3 intentos después
-- del último SMS" dio 304. Ambas inservibles.
--
-- La señal que SÍ discrimina es `rate_limits.count` de las claves
-- `send-sms-otp:phone:*`. send-sms-otp incrementa el contador ANTES de hablar con D7
-- y llama refundOtpBudget() SOLO en las rutas de fallo (D7 rechaza / token ausente /
-- error de insert). Entonces, por ventana de 10 min:
--     count >= 1  → el envío salió
--     count  = 0  → el envío falló y se reembolsó el token
-- Es auto-gatillada por demanda: sin solicitudes no hay filas y no hay alerta.
--
-- UMBRAL VALIDADO CONTRA EL HISTORIAL (no elegido a ojo):
--   últimas 3 solicitudes todas en 0 →  6 falsos positivos en 1438 h
--   últimas 5 solicitudes todas en 0 →  0 falsos positivos, detecta 25/25 h del apagón  ← elegido
--   últimas 8 solicitudes todas en 0 →  0 falsos, pero detecta 24/25 (más lento)
-- Con K=5 la alerta habría salido el 2026-08-06 21:50 UTC: 6 h 15 min después del
-- corte en vez de 31 h. La latencia la impone el tráfico bajo (hacen falta 5 ventanas
-- de 10 min con actividad), y es el precio de tener CERO ruido.
--
-- ⚠️ DEPENDENCIA LOAD-BEARING: esta detección se apoya en que send-sms-otp REEMBOLSE
-- el budget en las rutas de fallo (refundOtpBudget, introducido en mig 00491 / PR #783).
-- Si alguien quita ese reembolso, `count` nunca volverá a 0 y este watchdog quedará
-- CIEGO EN SILENCIO. Antes de tocar el reembolso, cambiar también esta función.
--
-- ALCANCE DELIBERADO: detecta el apagón TOTAL, no la degradación parcial. El prefijo 6
-- de ETECSA entrega ~48% (ver memoria project_sms_provider_d7) y alertar sobre eso
-- sería ruido permanente.
--
-- Patrón de alerta: solo notifica en TRANSICIÓN (ok→down, down→ok), igual que 00503 y
-- proxy-health, así que un apagón que persiste no hace spam cada 15 min.
-- El email va por public.cron_http_post (convención de 00555) para que
-- check_cron_http_failures() vea si send-email falla.

-- ── Umbral configurable (admin puede ajustarlo sin redeploy) ─────────────────────
INSERT INTO platform_config (key, value)
VALUES ('sms_outage_alert_consecutive', '5'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.check_sms_delivery_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_k              int;
  v_muestra        int := 0;
  v_fallidas       int := 0;
  v_ultima_req     timestamptz;
  v_ultimo_sms     timestamptz;
  v_edad_sms_txt   text;
  v_afectados      int := 0;
  v_status         text;
  v_prev           text;
  v_now            timestamptz := now();
  v_service_key    text;
  v_headers        jsonb;
  v_to_raw         text;
  v_rcpt           text;
  v_subject        text;
  v_html           text;
  v_detalle        text;
  v_sent           int := 0;
BEGIN
  SELECT GREATEST(COALESCE((value #>> '{}')::int, 5), 2) INTO v_k
    FROM platform_config WHERE key = 'sms_outage_alert_consecutive';
  v_k := COALESCE(v_k, 5);

  -- Las últimas K solicitudes de OTP (1 fila = 1 ventana de 10 min con actividad).
  SELECT count(*), count(*) FILTER (WHERE v_ult.intentos = 0), max(v_ult.inicio)
    INTO v_muestra, v_fallidas, v_ultima_req
    FROM (
      SELECT rl.count AS intentos, rl.window_start AS inicio
        FROM rate_limits rl
       WHERE rl.key LIKE 'send-sms-otp:phone:%'
       ORDER BY rl.window_start DESC
       LIMIT v_k
    ) AS v_ult;

  SELECT max(sd.sent_at) INTO v_ultimo_sms FROM sms_deliveries sd;

  v_edad_sms_txt := CASE
    WHEN v_ultimo_sms IS NULL THEN 'nunca'
    ELSE round(extract(epoch FROM (v_now - v_ultimo_sms)) / 3600.0, 1)::text || ' h' END;

  -- Teléfonos distintos que pidieron un código desde el último SMS que sí salió.
  IF v_ultimo_sms IS NOT NULL THEN
    SELECT count(DISTINCT replace(rl.key, 'send-sms-otp:phone:', ''))
      INTO v_afectados
      FROM rate_limits rl
     WHERE rl.key LIKE 'send-sms-otp:phone:%'
       AND rl.window_start > v_ultimo_sms;
  END IF;

  -- Tres estados. 'unknown' cuando no hay evidencia suficiente: nunca emite correo,
  -- así que un apagón durante el cual la gente deja de intentar NO dispara un falso
  -- "recuperado" (con 2 estados, quedarse sin datos se leería como recuperación).
  v_status := CASE
    WHEN v_muestra < v_k OR v_ultima_req IS NULL
         OR v_ultima_req < v_now - interval '24 hours' THEN 'unknown'
    WHEN v_fallidas = v_muestra                        THEN 'down'
    ELSE 'ok' END;

  v_detalle := v_fallidas::text || '/' || v_muestra::text || ' solicitudes fallidas · '
            || 'último SMS hace ' || v_edad_sms_txt
            || CASE WHEN v_afectados > 0
                    THEN ' · ' || v_afectados::text || ' teléfonos afectados' ELSE '' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'sms_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persistir SIEMPRE el estado, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES
    ('sms_health_status', to_jsonb(v_status)),
    ('sms_health_at',     to_jsonb(v_now::text)),
    ('sms_health_detail', to_jsonb(v_detalle))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- ── Alertar SOLO en transición; 'unknown' nunca notifica ────────────────────────
  IF (v_status = 'down' AND v_prev <> 'down')
     OR (v_status = 'ok' AND v_prev = 'down') THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'down' THEN
        v_subject := '[TriciGo] SMS CAÍDO — nadie puede iniciar sesión';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">SMS caído</h2>'
          || '<p>Las últimas <b>' || v_muestra::text || ' solicitudes de código fallaron todas</b>. '
          || 'Mientras dure, <b>nadie puede iniciar sesión con su teléfono</b> (conductores ni pasajeros) '
          || 'y tampoco salen el <b>SOS de emergencia</b> ni el link de viaje a contactos de confianza.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último SMS enviado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_sms::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antigüedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_edad_sms_txt || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Teléfonos afectados</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_afectados::text || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><b>Qué revisar, en este orden:</b></p>'
          || '<ol>'
          || '<li><b>Saldo en D7</b> (<code>app.d7networks.com</code>) — es prepago y es la causa más común. '
          || 'A ~$0.07 por SMS a Cuba, ~140 SMS por cada $10.</li>'
          || '<li><b>Token</b> <code>D7_API_TOKEN</code> en los secrets de Edge Functions, por si fue rotado o revocado.</li>'
          || '<li><b>Logs de la Edge Function</b> <code>send-sms-otp</code>: la línea <code>[d7] send:</code> trae '
          || 'el status y el payload <code>errors</code> exactos que devolvió D7.</li>'
          || '</ol>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de SMS (00556). No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] SMS recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">SMS recuperado</h2>'
          || '<p>Los códigos de verificación vuelven a salir. El inicio de sesión por teléfono funciona normalmente.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último SMS enviado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_sms::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de SMS (00556). No responder.</p>'
          || '</body></html>';
      END IF;

      -- business_notification_email puede ser CSV; send-email toma un destinatario por llamada.
      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM public.cron_http_post('sms-outage-alert',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       -- HTML crudo: send-email lo acepta por el legacy path de
                       -- resolveTemplate(). El guardrail solo rechaza slugs pelados.
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev,
    'muestra', v_muestra, 'fallidas', v_fallidas,
    'ultimo_sms', v_ultimo_sms, 'telefonos_afectados', v_afectados,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_sms_delivery_health failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_sms_delivery_health() IS
  '00556: Watchdog de apagón total de SMS (D7). Detecta vía rate_limits.count=0 de las '
  'claves send-sms-otp:phone:* (0 = envío fallido y reembolsado). Alerta por email en '
  'transición ok<->down. SQL puro a propósito: detectar vía net.http_post heredaría la '
  'ceguera de pg_cron. DEPENDE de que send-sms-otp siga reembolsando el budget en las '
  'rutas de fallo (mig 00491): sin eso queda ciego en silencio.';

REVOKE ALL ON FUNCTION public.check_sms_delivery_health() FROM PUBLIC, anon, authenticated;

-- ── Cron cada 15 min ────────────────────────────────────────────────────────────
-- El umbral de 5 solicitudes fallidas ya impone la latencia real; sondear seguido solo
-- recorta el retraso entre la 5ª falla y el aviso.
SELECT cron.unschedule('check-sms-delivery-health')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-sms-delivery-health');

SELECT cron.schedule(
  'check-sms-delivery-health',
  '*/15 * * * *',
  $cron$SELECT public.check_sms_delivery_health();$cron$
);
