-- 00507: fix check_cron_http_failures() -- a plpgsql RECORD variable shadowed the
-- SQL table alias, so the reconciler failed on every run.
--
-- 00506 declared `r RECORD` for its FOR loop AND aliased net._http_response as `r`
-- in the detection query. plpgsql resolves `r.status_code` against the (still
-- unassigned) RECORD variable rather than the SQL alias, so every call returned
--   {"ok":false,"error":"record \"r\" is not assigned yet"}
-- The function's EXCEPTION WHEN OTHERS contained it: nothing broke, but the
-- watchdog was blind -- precisely the failure mode it exists to prevent.
--
-- Proven in isolation before fixing:
--   DECLARE r     RECORD; ... FROM net._http_response r  -> ERROR record "r" is not assigned yet
--   DECLARE v_row RECORD; ... FROM net._http_response r  -> works
--
-- WHY 00506'S TESTING MISSED IT: the detection query was verified STANDALONE,
-- where no plpgsql variable exists to shadow the alias. The collision only exists
-- inside the function. Test the function, not the query it contains.
--
-- Fixed on BOTH sides so it cannot recur: loop variable is v_fail, response alias
-- is resp. Also drops a stale temp table defensively before recreating it.

CREATE OR REPLACE FUNCTION public.check_cron_http_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  -- pg_net keeps responses for 6h; a 90min window stays well inside that while
  -- covering the slowest job (behavioral-emails, daily) on the next tick.
  c_window_min  constant integer := 90;
  -- A call younger than this may legitimately have no response row yet.
  c_grace_sec   constant integer := 120;
  v_signature   text;    -- set of failing jobnames — the de-dup key
  v_detail      text;    -- human-readable, includes counts
  v_prev        text;
  v_status      text;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_rows        text := '';
  v_fail        RECORD;
  v_sent        integer := 0;
BEGIN
  DROP TABLE IF EXISTS _fails;
  CREATE TEMP TABLE _fails ON COMMIT DROP AS
  SELECT c.jobname,
         count(*)                                                   AS failures,
         count(*) FILTER (WHERE resp.status_code IS NULL)               AS timeouts,
         string_agg(DISTINCT COALESCE(resp.status_code::text, 'timeout'), '/' ORDER BY COALESCE(resp.status_code::text,'timeout')) AS codes,
         max(left(COALESCE(resp.content, resp.error_msg, ''), 120))        AS sample
  FROM public.cron_http_calls c
  JOIN net._http_response resp ON resp.id = c.request_id
  LEFT JOIN public.cron_http_expectations e ON e.jobname = c.jobname
  WHERE c.called_at >  now() - make_interval(mins => c_window_min)
    AND c.called_at <  now() - make_interval(secs => c_grace_sec)
    AND (resp.status_code IS NULL
         OR NOT (resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204]))))
  GROUP BY c.jobname;

  SELECT string_agg(jobname, ',' ORDER BY jobname),
         string_agg(jobname || ' (' || failures || '× ' || codes || ')', ' · ' ORDER BY jobname)
    INTO v_signature, v_detail
  FROM _fails;

  v_status := CASE WHEN v_signature IS NULL THEN 'ok' ELSE 'failing' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'cron_http_health_signature';

  INSERT INTO platform_config (key, value) VALUES
    ('cron_http_health_status',    to_jsonb(v_status)),
    ('cron_http_health_signature', to_jsonb(COALESCE(v_signature, ''))),
    ('cron_http_health_detail',    to_jsonb(COALESCE(v_detail, 'all cron HTTP calls healthy'))),
    ('cron_http_health_at',        to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- De-dup on the SET of failing jobs, not on the counts: a job that keeps
  -- failing stays quiet, but a NEW job joining the failure set alerts even while
  -- another is already down.
  IF COALESCE(v_signature,'') IS DISTINCT FROM COALESCE(v_prev,'') THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object('Content-Type','application/json',
                     'Authorization','Bearer ' || v_service_key, 'apikey', v_service_key);

      IF v_status = 'failing' THEN
        FOR v_fail IN SELECT * FROM _fails ORDER BY jobname LOOP
          v_rows := v_rows
            || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>' || v_fail.jobname || '</b></td>'
            || '<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_fail.failures || '× ' || v_fail.codes || '</td></tr>'
            || '<tr><td colspan="2" style="padding:2px 6px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px">'
            || coalesce(replace(replace(v_fail.sample,'<','&lt;'),'>','&gt;'), '') || '</td></tr>';
        END LOOP;
        v_subject := '[TriciGo] Cron -> Edge Function fallando';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Cron → Edge Function fallando</h2>'
          || '<p>Estas llamadas HTTP de cron devolvieron un estado inesperado en los últimos '
          || c_window_min || ' min. <b>pg_cron las reporta como &laquo;succeeded&raquo;</b> — solo se ven acá.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
          || '<p><b>Qué revisar:</b> los logs de la Edge Function correspondiente. '
          || 'Detalle completo: <code>SELECT * FROM cron_http_calls c JOIN net._http_response r ON r.id=c.request_id '
          || 'WHERE c.called_at &gt; now() - interval ''2 hours'' AND resp.status_code &lt;&gt; 200;</code></p>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de crons HTTP. No responder.</p></body></html>';
      ELSE
        v_subject := '[TriciGo] Cron -> Edge Function recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Crons recuperados</h2>'
          || '<p>Todas las llamadas HTTP de cron vuelven a responder lo esperado.</p>'
          || '<p style="color:#777;font-size:12px">Anterior: ' || COALESCE(v_prev,'—') || '</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de crons HTTP. No responder.</p></body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject,
                                        'template', v_html, 'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  DELETE FROM public.cron_http_calls WHERE called_at < now() - interval '24 hours';

  RETURN jsonb_build_object('status', v_status, 'prev', COALESCE(v_prev,''),
                            'failing', COALESCE(v_signature,''), 'detail', v_detail,
                            'emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  -- Defensive: the watchdog must never break its own cron.
  RAISE WARNING 'check_cron_http_failures failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

