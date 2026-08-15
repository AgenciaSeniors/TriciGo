-- 00566: Watchdog de ENTREGA de SMS (D7) + corrección de estados degradados
--
-- CONTEXTO (incidente 2026-08-15)
-- Entre las 03:16:19 y las 18:31:58 UTC (15 h 16 min) D7 aceptó los 17 SMS que se le
-- mandaron —HTTP 200, con request_id y sin `errors`— y el operador no entregó NINGUNO:
-- los 17 DLR volvieron `un_delivered` en ~6,6 s promedio. Seis personas quedaron sin
-- poder entrar; un conductor lo reportó 16 h después del corte. Se recuperó solo a las
-- 18:46, drenando la cola con latencias que bajaron de 34 min a 9 s.
--
-- NINGÚN watchdog lo vio. Los dos que existen miran otra capa:
--   • check_sms_delivery_health() (00556) mide rate_limits → si el envío SALIÓ.
--     Durante las 15 h reportó 'ok', porque los envíos salían perfectos.
--   • check-sms-balance (EF) mide el saldo prepago. Estaba bajo pero no era la causa.
-- Es la misma ceguera de capa que documentan 00503 y 00506/00507 (pg_cron registra el
-- encolado, no el HTTP): se estaba midiendo el submit y llamándolo "delivery health".
-- Esta función mide lo que faltaba: el ACUSE del operador (sms_deliveries.status).
--
-- ── LA SEÑAL: racha de fallos consecutivos, no tasa por ventana ───────────────────
-- Se probó primero la regla obvia —% de fallo por ventana de 30 min— y NO sirve con
-- este volumen: en 60 días solo hay 147 ventanas con ≥3 mensajes finalizados, y el
-- apagón de 15 h nunca junta 4 fallos dentro de una misma ventana. Quedaría ciego.
--
-- La señal que sí discrimina es la racha de `un_delivered` consecutivos sin ninguna
-- entrega intercalada. Medido sobre 60 días (2026-06-16 → 2026-08-15):
--     racha 1 → 26 veces          racha 2 → 2 veces (1 destinatario)
--     racha 3 →  2 veces (una de 1 destinatario, otra de 2, ambas ≤6 min)
--     racha 17 → 1 vez  ← el apagón, 6 destinatarios, 15,3 h
-- Las rachas cortas son el mismo teléfono apagado reintentando, no una caída.
--
-- UMBRAL VALIDADO CONTRA EL HISTORIAL (no elegido a ojo):
--   ≥3 consecutivos                → 2 falsos positivos en 60 días
--   ≥4 consecutivos                → 1 falso positivo (la racha de 11-ago, 6 min)
--   ≥4 consecutivos Y ≥2 destinatarios → 0 falsos positivos, detecta el apagón  ← elegido
-- Exigir 2 destinatarios distintos es lo que separa "la red no entrega" de "este
-- teléfono está apagado", que es el modo de falla normal y no debe despertar a nadie.
--
-- LATENCIA HONESTA: con este umbral la alerta de hoy habría salido a las 10:26 UTC —
-- 8 h antes de que se recuperara, con 12 SMS y 4 personas todavía por fallar. No sale
-- antes porque entre las 03:21 y las 10:26 NADIE intentó entrar: sin tráfico no hay
-- señal. Cerrar ese hueco exige una sonda sintética (~$0.07 por sonda) y no se hace acá.
--
-- ALCANCE DELIBERADO: detecta que la ruta dejó de entregar, no la degradación parcial.
-- El prefijo 6 de ETECSA entrega ~48% de forma crónica y alertar sobre eso sería ruido
-- permanente — por eso la condición es una racha SIN entregas, no un porcentaje.
--
-- Alerta solo en TRANSICIÓN (ok→down, down→ok), igual que 00503/00556 y proxy-health.
-- El email va por public.cron_http_post para que check_cron_http_failures() lo vea
-- fallar. Estado propio (sms_delivery_*) y un solo escritor, como el proxy por capas:
-- 00556 es dueño de sms_health_* (submit) y esta función de sms_delivery_* (entrega).

-- ── Corrección de datos: DLR fuera de orden degradaba estados finales ────────────
-- process-sms-dlr hacía un upsert incondicional, así que un acuse 'sent' que llegaba
-- DESPUÉS del 'delivered' pisaba el estado final. Quedaron 6 filas con status='sent' y
-- delivered_at poblado: entregas contadas como no resueltas. Sin esto el watchdog de
-- arriba mediría sobre datos corruptos. La guarda en el webhook va en el mismo PR.
UPDATE sms_deliveries
   SET status = 'delivered'
 WHERE status <> 'delivered'
   AND delivered_at IS NOT NULL;

-- ── Umbrales configurables (admin los ajusta sin redeploy) ───────────────────────
INSERT INTO platform_config (key, value) VALUES
  ('sms_delivery_fail_streak',   '4'::jsonb),
  ('sms_delivery_min_recipients','2'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.check_sms_delivery_rate()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_k             int;
  v_min_dest      int;
  v_racha         int := 0;
  v_destinatarios int := 0;
  v_primer_fallo  timestamptz;
  v_ultimo_fin    timestamptz;
  v_atascados     int := 0;
  v_req_ids       text;
  v_status        text;
  v_prev          text;
  v_now           timestamptz := now();
  v_service_key   text;
  v_headers       jsonb;
  v_to_raw        text;
  v_rcpt          text;
  v_subject       text;
  v_html          text;
  v_detalle       text;
  v_horas_txt     text;
  v_sent          int := 0;
BEGIN
  SELECT GREATEST(COALESCE((value #>> '{}')::int, 4), 2) INTO v_k
    FROM platform_config WHERE key = 'sms_delivery_fail_streak';
  v_k := COALESCE(v_k, 4);

  SELECT GREATEST(COALESCE((value #>> '{}')::int, 2), 1) INTO v_min_dest
    FROM platform_config WHERE key = 'sms_delivery_min_recipients';
  v_min_dest := COALESCE(v_min_dest, 2);

  -- Racha de fallos MÁS RECIENTES: se cuentan los un_delivered desde el final hacia
  -- atrás y se corta en la primera entrega. LIMIT 50 acota el escaneo; una racha mayor
  -- igual supera cualquier umbral razonable, así que truncar no puede ocultar nada.
  WITH v_fin AS (
    SELECT sd.status, sd.recipient, sd.sent_at, sd.request_id,
           row_number() OVER (ORDER BY sd.sent_at DESC) AS rn
      FROM sms_deliveries sd
     WHERE sd.status IN ('delivered', 'un_delivered')
     ORDER BY sd.sent_at DESC
     LIMIT 50
  ), v_corte AS (
    -- Posición de la entrega más reciente; sin entregas, toda la muestra es racha.
    SELECT COALESCE(min(rn) FILTER (WHERE status = 'delivered'), 51) AS primera_ok
      FROM v_fin
  )
  SELECT count(*), count(DISTINCT f.recipient), min(f.sent_at),
         string_agg(f.request_id, ', ' ORDER BY f.sent_at DESC)
                   FILTER (WHERE f.rn <= 3)
    INTO v_racha, v_destinatarios, v_primer_fallo, v_req_ids
    FROM v_fin f, v_corte c
   WHERE f.rn < c.primera_ok;

  v_racha         := COALESCE(v_racha, 0);
  v_destinatarios := COALESCE(v_destinatarios, 0);

  SELECT max(sd.sent_at) INTO v_ultimo_fin
    FROM sms_deliveries sd
   WHERE sd.status IN ('delivered', 'un_delivered');

  -- Informativo, NO dispara por sí solo: durante la recuperación del 15-ago los acuses
  -- tardaron hasta 34 min de forma legítima (cola drenando), así que alertar por esto
  -- sería ruido. Va en el detalle porque distingue "rechaza rápido" de "retiene".
  SELECT count(*) INTO v_atascados
    FROM sms_deliveries sd
   WHERE sd.status = 'sent'
     AND sd.sent_at > v_now - interval '24 hours'
     AND sd.sent_at < v_now - interval '30 minutes';

  -- 'unknown' cuando no hay evidencia fresca: sin tráfico reciente no se puede afirmar
  -- ni que entrega ni que no. Nunca emite correo, así que un apagón durante el cual la
  -- gente deja de intentar NO se lee como recuperación.
  v_status := CASE
    WHEN v_ultimo_fin IS NULL
      OR v_ultimo_fin < v_now - interval '24 hours'          THEN 'unknown'
    WHEN v_racha >= v_k AND v_destinatarios >= v_min_dest    THEN 'down'
    ELSE 'ok' END;

  v_horas_txt := CASE
    WHEN v_primer_fallo IS NULL THEN '—'
    ELSE round(extract(epoch FROM (v_now - v_primer_fallo)) / 3600.0, 1)::text || ' h' END;

  v_detalle := v_racha::text || ' fallos seguidos · '
            || v_destinatarios::text || ' destinatarios'
            || CASE WHEN v_racha > 0 THEN ' · desde hace ' || v_horas_txt ELSE '' END
            || CASE WHEN v_atascados > 0
                    THEN ' · ' || v_atascados::text || ' sin acuse >30 min' ELSE '' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'sms_delivery_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persistir SIEMPRE el estado, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES
    ('sms_delivery_status', to_jsonb(v_status)),
    ('sms_delivery_at',     to_jsonb(v_now::text)),
    ('sms_delivery_detail', to_jsonb(v_detalle))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- ── Alertar SOLO en transición; 'unknown' nunca notifica ───────────────────────
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
        v_subject := '[TriciGo] Los SMS salen pero NO llegan — la ruta a Cuba no entrega';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">SMS aceptados pero no entregados</h2>'
          || '<p>D7 está <b>aceptando</b> los mensajes (HTTP 200) pero el operador devuelve '
          || '<code>un_delivered</code>: <b>' || v_racha::text || ' seguidos</b> a <b>'
          || v_destinatarios::text || ' teléfonos distintos</b>. Mientras dure, quien intente '
          || 'entrar <b>no recibe su código</b>, aunque en los logs el envío se vea exitoso. '
          || 'Tampoco llegan el <b>SOS</b> ni el link de viaje a contactos de confianza.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fallos consecutivos</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_racha::text || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Teléfonos afectados</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_destinatarios::text || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Primer fallo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_primer_fallo::text, '—') || ' (' || v_horas_txt || ')</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><b>Qué hacer:</b> esto casi nunca se arregla del lado de TriciGo — el mensaje '
          || 'sale bien. Abrir ticket en <code>app.d7networks.com</code> pidiendo el motivo del '
          || '<code>un_delivered</code> en la ruta +53 y si el sender ID <code>TriciGo</code> '
          || 'sigue habilitado en ETECSA, citando estos request_id:</p>'
          || '<p style="font-family:monospace;font-size:12px;background:#f5f5f5;padding:8px;border-radius:4px">'
          || COALESCE(v_req_ids, '—') || '</p>'
          || '<p>Ojo: <b>cada intento se cobra igual</b> (~$0.07 a Cuba) aunque no se entregue.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog de entrega de SMS (00566). Mide el acuse del '
          || 'operador, no el envío. Umbrales en platform_config.sms_delivery_fail_streak / '
          || 'sms_delivery_min_recipients. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] Entrega de SMS recuperada';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Entrega de SMS recuperada</h2>'
          || '<p>El operador volvió a acusar entregas. Los códigos de verificación llegan otra vez.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último acuse</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_fin::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog de entrega de SMS (00566). No responder.</p>'
          || '</body></html>';
      END IF;

      -- business_notification_email puede ser CSV; send-email toma un destinatario por llamada.
      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM public.cron_http_post('sms-delivery-alert',
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
    'racha', v_racha, 'destinatarios', v_destinatarios,
    'primer_fallo', v_primer_fallo, 'sin_acuse_30min', v_atascados,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_sms_delivery_rate failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_sms_delivery_rate() IS
  '00566: Watchdog de ENTREGA de SMS (D7). Complementa a check_sms_delivery_health() '
  '(00556), que mide si el envío SALIÓ: esta mide si el operador lo ACUSÓ, leyendo la '
  'racha de un_delivered consecutivos en sms_deliveries. Umbral ≥4 seguidos con ≥2 '
  'destinatarios distintos: 0 falsos positivos en 60 días de historia. Alerta por email '
  'en transición ok<->down. Sin tráfico no hay señal (por diseño: no hay sonda sintética).';

REVOKE ALL ON FUNCTION public.check_sms_delivery_rate() FROM PUBLIC, anon, authenticated;

-- ── Cron cada 15 min ───────────────────────────────────────────────────────────
-- Mismo ritmo que 00556: el umbral de la racha impone la latencia real, sondear más
-- seguido solo recorta el retraso entre el 4º fallo y el aviso.
SELECT cron.unschedule('check-sms-delivery-rate')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-sms-delivery-rate');

SELECT cron.schedule(
  'check-sms-delivery-rate',
  '*/15 * * * *',
  $cron$SELECT public.check_sms_delivery_rate();$cron$
);
