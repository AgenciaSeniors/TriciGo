-- ============================================================
-- Migration 00574: que un sync de POIs caído AVISE
--
-- WHY
--   00573 arregla POR QUÉ se cayeron los syncs. Esto arregla por qué nadie
--   se enteró. Medido el 2026-08-22 con `gh run list`:
--
--     · sync-osm-delta.yml  -> en rojo TODOS los días desde el 2026-06-24.
--       Sus únicos "success" (08-03, 07-20, 07-13, 07-06, 06-29 ...) son
--       no-ops: el log dice `already up to date at seq NNNN` y el script
--       retorna 0 SIN llamar al RPC. O sea: el delta diario nunca aplicó
--       un solo diff desde que existe (creado el 2026-05-24).
--     · sync-pois.yml       -> en rojo desde el 2026-08-17.
--
--   Dos semanas en rojo y ~2 meses de delta muerto sin una sola alerta.
--   El paso de Slack de ambos workflows está doblemente muerto:
--     1. el secret SLACK_WEBHOOK_OPS no existe (`gh secret list`), y
--     2. su condición es `if: always() && env.SLACK_WEBHOOK != ''` con
--        SLACK_WEBHOOK definido en el `env:` DEL PROPIO PASO -- GitHub
--        evalúa el `if:` ANTES de montar el env del paso, así que
--        `env.SLACK_WEBHOOK` siempre vale '' y el paso NUNCA corre.
--        Verificado: en el run 32002252161 el paso figura `skipped`
--        aunque el job entero falló.
--
--   Misma familia que la "ceguera de crons" de CLAUDE.md: el mecanismo
--   que debía avisar estaba roto, así que el fallo fue invisible.
--
-- WHAT THIS DOES -- dos capas, cada una tapa un agujero que la otra no:
--
--   A) notify_ops_workflow_failure(workflow, run_url, detail)
--      La llaman los propios workflows desde un paso `if: failure()`.
--      Cubre el fallo DURO (run en rojo). Genérica a propósito: cualquier
--      workflow puede usarla, no solo los de POIs.
--
--   B) check_poi_sync_freshness()  [cron horario]
--      Cubre lo que (A) no puede ver: que el workflow DEJE DE CORRER
--      (deshabilitado, renombrado, o GitHub apagando los schedules).
--      Sin run no hay fallo, y sin fallo (A) nunca dispara. Este mira el
--      INVARIANTE -- "¿hubo un sync de POIs exitoso hace poco?" -- leyendo
--      poi_sync_state directo.
--
--   Igual que 00503, la DETECCIÓN de (B) es SQL puro. Una Edge Function
--   invocada por net.http_post heredaría la misma ceguera que dejó el
--   incidente de FX invisible 4 días: si el watchdog se cae, el cron
--   sigue reportando éxito. Acá el único HTTP es el email, que es la
--   ACCIÓN, no la detección -- un fallo de envío no puede ocultar el
--   estado, que queda en poi_sync_health_status.
-- ============================================================

-- -- Config --------------------------------------------------------------
-- 50 h = dos corridas diarias perdidas + margen. El delta corre a diario y
-- (desde este PR) escribe heartbeat aun cuando no hay diffs que aplicar,
-- así que en salud la edad nunca pasa de ~24 h.
INSERT INTO platform_config (key, value)
VALUES ('poi_sync_stale_alert_hours', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Anti-spam de (A): un mismo workflow no vuelve a emailar dentro de N horas.
-- Los workflows corren 1x/día, así que esto solo frena tormentas de re-runs.
INSERT INTO platform_config (key, value)
VALUES ('ops_workflow_alert_cooldown_hours', '6'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Sembramos el estado ACTUAL conocido (stale: último sync 2026-08-10) para
-- que la primera corrida del watchdog NO dispare un email de "caído" que ya
-- sabemos. Así el único correo que llega es el de RECUPERADO tras el primer
-- sync exitoso post-00573 -- que además prueba en vivo que la cadena anda.
INSERT INTO platform_config (key, value)
VALUES ('poi_sync_health_status', '"stale"'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- ========================================================================
-- A) Alerta de fallo duro, llamada por el propio workflow
-- ========================================================================
CREATE OR REPLACE FUNCTION public.notify_ops_workflow_failure(
  p_workflow text,
  p_run_url  text DEFAULT NULL,
  p_detail   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_cooldown_h  numeric;
  v_last_key    text;
  v_last_at     timestamptz;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_sent        int := 0;
  v_wf          text;
  v_detail      text;
  v_url         text;
  v_url_html    text;
BEGIN
  IF p_workflow IS NULL OR btrim(p_workflow) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workflow required');
  END IF;

  -- Escapar TODO lo que viene del caller: entra a un email de operaciones.
  -- Cap de largo para que un log gigante no arme un correo de megabytes.
  v_wf := left(btrim(p_workflow), 120);
  v_wf := replace(replace(replace(v_wf, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  v_detail := left(COALESCE(btrim(p_detail), ''), 2000);
  v_detail := replace(replace(replace(v_detail, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  -- Solo linkeamos si es realmente una URL de GitHub; si no, va como texto.
  v_url := left(COALESCE(btrim(p_run_url), ''), 500);
  IF v_url LIKE 'https://github.com/%' AND v_url !~ '[<>"'']' THEN
    v_url_html := '<a href="' || v_url || '">' || v_url || '</a>';
  ELSIF v_url <> '' THEN
    v_url_html := replace(replace(replace(v_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  ELSE
    v_url_html := '-';
  END IF;

  -- -- Cooldown por workflow ---------------------------------------------
  SELECT (value #>> '{}')::numeric INTO v_cooldown_h
    FROM platform_config WHERE key = 'ops_workflow_alert_cooldown_hours';
  v_cooldown_h := COALESCE(v_cooldown_h, 6);

  v_last_key := 'ops_workflow_alert_at:' || left(btrim(p_workflow), 120);
  SELECT (value #>> '{}')::timestamptz INTO v_last_at
    FROM platform_config WHERE key = v_last_key;

  IF v_last_at IS NOT NULL AND v_last_at > v_now - make_interval(secs => v_cooldown_h * 3600) THEN
    RETURN jsonb_build_object(
      'ok', true, 'skipped', 'cooldown',
      'last_alert_at', v_last_at, 'cooldown_hours', v_cooldown_h, 'emails_sent', 0);
  END IF;

  -- Persistir SIEMPRE el intento, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES (v_last_key, to_jsonb(v_now::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  SELECT value #>> '{}' INTO v_to_raw
    FROM platform_config WHERE key = 'business_notification_email';

  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_notification_email unset', 'emails_sent', 0);
  END IF;

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);

  v_subject := '[TriciGo] Workflow en rojo: ' || left(btrim(p_workflow), 120);
  v_html :=
       '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Workflow fallido</h2>'
    || '<p>El workflow programado <b>' || v_wf || '</b> terminó en error.</p>'
    || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Workflow</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_wf || '</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Run</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_url_html || '</td></tr>'
    || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
    || '</table>'
    || CASE WHEN v_detail <> '' THEN
         '<p><b>Detalle:</b></p><pre style="background:#f6f6f6;padding:12px;border-radius:6px;white-space:pre-wrap;font-size:12px">' || v_detail || '</pre>'
       ELSE '' END
    || '<p><b>Qué revisar:</b> abrir el run de arriba y mirar el primer paso en rojo. '
    || 'Si es un sync de POIs, el estado del invariante está en '
    || '<code>platform_config.poi_sync_health_detail</code>.</p>'
    || '<p style="color:#777;font-size:12px">Alerta automática de operaciones. No responder.</p>'
    || '</body></html>';

  -- business_notification_email es CSV; send-email toma un destinatario por llamada.
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
                   -- HTML crudo: send-email lo acepta por el legacy path de
                   -- resolveTemplate(); el guardrail solo rechaza slugs pelados.
                   'template', v_html,
                   'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'workflow', p_workflow, 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: avisar de un fallo NUNCA debe agregar un segundo fallo.
  RAISE WARNING 'notify_ops_workflow_failure failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.notify_ops_workflow_failure(text, text, text) IS
  '00574: alerta por email cuando un workflow programado falla. La llaman los propios '
  'workflows desde un paso `if: failure()`. Solo service_role. Escapa el input del caller '
  '(entra a un correo de operaciones) y tiene cooldown por workflow.';

-- Solo el service_role (los workflows la llaman con SUPABASE_SERVICE_ROLE).
-- Manda correo a 5 personas reales: no puede quedar al alcance de anon.
REVOKE ALL ON FUNCTION public.notify_ops_workflow_failure(text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_ops_workflow_failure(text, text, text) TO service_role;


-- ========================================================================
-- B) Watchdog del invariante: ¿hubo un sync de POIs exitoso hace poco?
-- ========================================================================
CREATE OR REPLACE FUNCTION public.check_poi_sync_freshness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_last_at     timestamptz;
  v_last_kind   text;
  v_last_seq    bigint;
  v_age_h       numeric;
  v_age_txt     text;
  v_alert_h     numeric;
  v_status      text;
  v_prev        text;
  v_active      bigint;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_sent        int := 0;
BEGIN
  SELECT last_sync_at, last_sync_kind::text, last_sequence
    INTO v_last_at, v_last_kind, v_last_seq
    FROM poi_sync_state WHERE region = 'cuba' LIMIT 1;

  SELECT (value #>> '{}')::numeric INTO v_alert_h
    FROM platform_config WHERE key = 'poi_sync_stale_alert_hours';
  v_alert_h := COALESCE(v_alert_h, 50);

  IF v_last_at IS NULL THEN
    v_status  := 'stale';
    v_age_h   := NULL;
    v_age_txt := 'sin fila poi_sync_state';
  ELSE
    v_age_h   := round(extract(epoch FROM (v_now - v_last_at)) / 3600.0, 1);
    v_age_txt := v_age_h::text || ' h';
    v_status  := CASE WHEN v_age_h >= v_alert_h THEN 'stale' ELSE 'ok' END;
  END IF;

  SELECT count(*) INTO v_active FROM cuba_pois WHERE is_active;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'poi_sync_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persistir SIEMPRE el estado, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES
    ('poi_sync_health_status', to_jsonb(v_status)),
    ('poi_sync_health_at',     to_jsonb(v_now::text)),
    ('poi_sync_health_detail', to_jsonb(
       COALESCE(v_last_kind, '-') || ' - seq ' || COALESCE(v_last_seq::text, '-')
       || ' - ' || v_age_txt || ' - ' || v_active::text || ' POIs activos'))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- -- Alertar SOLO en transición (de-dup, igual que 00503 / proxy-health) --
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
        v_subject := '[TriciGo] El sync de POIs DEJO DE CORRER';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Sync de POIs detenido</h2>'
          || '<p>Hace <b>' || v_age_txt || '</b> que no se registra un sync de lugares exitoso. '
          || 'Los lugares del mapa y del buscador se van quedando viejos: no aparecen los negocios '
          || 'nuevos ni desaparecen los cerrados.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Ultimo sync</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_at::text, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tipo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_kind, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antiguedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_age_txt || '</td></tr>'
          || '<tr><td style="padding:6px"><b>POIs activos</b></td><td style="padding:6px;text-align:right">' || v_active::text || '</td></tr>'
          || '</table>'
          || '<p><b>Que revisar:</b> los workflows <code>sync-osm-delta.yml</code> (diario) y '
          || '<code>sync-pois.yml</code> (lunes) en GitHub Actions. Si NO figura ninguna corrida '
          || 'reciente, el schedule esta apagado -- que es justo el caso que este watchdog existe '
          || 'para atrapar, porque un workflow que no corre no puede avisar que fallo.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico del sync de POIs. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] El sync de POIs volvio a correr';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Sync de POIs recuperado</h2>'
          || '<p>Volvio a registrarse un sync de lugares exitoso.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Ultimo sync</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_at::text, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tipo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_kind, '-') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>POIs activos</b></td><td style="padding:6px;text-align:right">' || v_active::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico del sync de POIs. No responder.</p>'
          || '</body></html>';
      END IF;

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
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev, 'age_hours', v_age_h,
    'last_sync_at', v_last_at, 'last_kind', v_last_kind, 'active_pois', v_active,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_poi_sync_freshness failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_poi_sync_freshness() IS
  '00574: watchdog de frescura del sync de POIs (poi_sync_state.last_sync_at). Alerta por '
  'email SOLO en transicion ok<->stale. Existe para atrapar lo que un aviso desde el propio '
  'workflow no puede ver: que el workflow deje de correr -- sin run no hay fallo que avisar.';

REVOKE ALL ON FUNCTION public.check_poi_sync_freshness() FROM PUBLIC, anon, authenticated;

-- -- Cron: minuto 50 de cada hora -----------------------------------------
-- Horario y no diario porque el alerting es transition-only (no hace spam) y
-- así la detección no arrastra hasta 24 h de latencia extra.
SELECT cron.unschedule('check-poi-sync-freshness')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-poi-sync-freshness');

SELECT cron.schedule(
  'check-poi-sync-freshness',
  '50 * * * *',
  $cron$SELECT public.check_poi_sync_freshness();$cron$
);
