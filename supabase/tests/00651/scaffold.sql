-- Scaffold addition for the 00651 rehearsal, applied by run.sh on top of
-- supabase/tests/00640/scaffold.sql + migrations 00640 and 00647 (prod's state).
-- Copied from prod on 2026-10-11 (pg_get_functiondef): run.sh S0 compares the
-- md5 of prosrc and of pg_get_functiondef with the values read from prod.
-- Owner postgres, EXECUTE for postgres and service_role only, as in prod.
SET ROLE postgres;

CREATE OR REPLACE FUNCTION public.notify_ops_workflow_failure(p_workflow text, p_run_url text DEFAULT NULL::text, p_detail text DEFAULT NULL::text)
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

  v_wf := left(btrim(p_workflow), 120);
  v_wf := replace(replace(replace(v_wf, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  v_detail := left(COALESCE(btrim(p_detail), ''), 2000);
  v_detail := replace(replace(replace(v_detail, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');

  v_url := left(COALESCE(btrim(p_run_url), ''), 500);
  IF v_url LIKE 'https://github.com/%' AND v_url !~ '[<>"'']' THEN
    v_url_html := '<a href="' || v_url || '">' || v_url || '</a>';
  ELSIF v_url <> '' THEN
    v_url_html := replace(replace(replace(v_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  ELSE
    v_url_html := '-';
  END IF;

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

  RETURN jsonb_build_object('ok', true, 'workflow', p_workflow, 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_ops_workflow_failure failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

REVOKE ALL ON FUNCTION public.notify_ops_workflow_failure(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_ops_workflow_failure(text, text, text) TO service_role;

RESET ROLE;
