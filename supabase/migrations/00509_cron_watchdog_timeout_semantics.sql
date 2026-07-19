-- 00509: stop the cron watchdog crying wolf over pg_net timeouts.
--
-- WHAT IT DID WRONG
-- 00506 counted `net._http_response.status_code IS NULL` as a failure. It is not.
-- pg_net's timeout means "pg_net stopped waiting", NOT "the request failed" —
-- the Edge Function keeps running and can finish fine. Measured in prod today,
-- three consecutive hours, sync-exchange-rate:
--
--   cron fired 13:00:00 -> pg_net TIMEOUT -> exchange_rates written 13:00:09
--   cron fired 14:00:00 -> pg_net TIMEOUT -> exchange_rates written 14:00:09
--   cron fired 15:00:00 -> pg_net TIMEOUT -> exchange_rates written 15:00:09
--
-- Every "failure" was a completed, successful sync. The watchdog alerted at 13:40
-- and again at 14:40 because its de-dup key is the SET of failing jobs, and which
-- job happens to trip a sporadic timeout rotates hour to hour. Left alone it would
-- have emailed every hour forever — and an alert that cries wolf gets filtered,
-- which is worse than no alert at all.
--
-- ROOT CAUSE: pg_net's default timeout is 5s. These Edge Functions take ~9s
-- (cold isolate + upstream fetch). The 5s was never chosen for them — 00506
-- inherited it verbatim to preserve pre-existing behaviour, and the timeouts long
-- predate this watchdog. It just made them visible for the first time.
--
-- TWO FIXES, because either alone is insufficient:
--   1. Wait long enough to actually observe the outcome (5s -> 30s). Without this
--      the watchdog is blind to what these jobs really returned.
--   2. Stop treating "unknown" as "failed". Even at 30s a timeout does not prove
--      the function did not run, so it must not, on its own, raise an alarm.

-- ── 1. Give pg_net time to see the answer ────────────────────────────────────
-- The seven crons call cron_http_post() WITHOUT timeout_milliseconds, so they all
-- pick this up. No cron rewrite needed.
CREATE OR REPLACE FUNCTION public.cron_http_post(
  p_jobname            text,
  url                  text,
  headers              jsonb DEFAULT '{}'::jsonb,
  body                 jsonb DEFAULT '{}'::jsonb,
  -- 30s: measured worst case is ~9s (cold start + upstream). pg_net is an async
  -- background worker, so a longer wait costs a worker slot, not a connection.
  timeout_milliseconds integer DEFAULT 30000
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  -- Fire FIRST, log second (see 00506): a bookkeeping failure must degrade the
  -- job to "untracked", never to "not sent".
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$;

-- ── 2. Distinguish "it answered badly" from "we did not hear back" ───────────
CREATE OR REPLACE FUNCTION public.check_cron_http_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  c_window_min  constant integer := 90;
  c_grace_sec   constant integer := 120;
  -- One odd 5xx among dozens of successes is noise; two is a pattern.
  c_min_hard    constant integer := 2;
  v_signature   text;
  v_detail      text;
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
  WITH judged AS (
    SELECT c.jobname,
           resp.status_code,
           resp.content,
           resp.error_msg,
           (resp.status_code IS NULL)                                        AS is_timeout,
           (resp.status_code IS NOT NULL
            AND NOT (resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204])))) AS is_hard_fail,
           (resp.status_code IS NOT NULL
            AND resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204])))       AS is_ok
    FROM public.cron_http_calls c
    JOIN net._http_response resp ON resp.id = c.request_id
    LEFT JOIN public.cron_http_expectations e ON e.jobname = c.jobname
    WHERE c.called_at >  now() - make_interval(mins => c_window_min)
      AND c.called_at <  now() - make_interval(secs => c_grace_sec)
  ),
  agg AS (
    SELECT jobname,
           count(*)                                    AS total,
           count(*) FILTER (WHERE is_ok)               AS oks,
           count(*) FILTER (WHERE is_hard_fail)        AS hard_fails,
           count(*) FILTER (WHERE is_timeout)          AS timeouts,
           string_agg(DISTINCT status_code::text, '/')
             FILTER (WHERE is_hard_fail)               AS codes,
           max(left(COALESCE(content, error_msg, ''), 120))
             FILTER (WHERE is_hard_fail OR is_timeout) AS sample
    FROM judged GROUP BY jobname
  )
  SELECT jobname,
         (hard_fails + CASE WHEN oks = 0 THEN timeouts ELSE 0 END) AS failures,
         timeouts,
         COALESCE(codes, 'timeout') AS codes,
         sample
  FROM agg
  WHERE
    -- (a) It answered, and the answer was wrong — more than once.
    hard_fails >= c_min_hard
    -- (b) Or it went completely silent: no success at all, and silent more than
    --     once. A timeout among successes is pg_net giving up early, not a
    --     failure (proven: 3 consecutive "timeouts" whose Edge Function completed
    --     and wrote its row 9s later).
    --
    --     The >= c_min_hard on timeouts matters for LOW-FREQUENCY jobs: an hourly
    --     job has ~2 samples in a 90min window and a daily one has 0-1, so a
    --     single unlucky sample would otherwise read as "totally silent". Costs
    --     one extra cycle of detection latency (2h for an hourly job) against an
    --     outage that previously went unnoticed for 4 days — and sync-exchange-
    --     rate, the one job where an hour matters, has its own data-freshness
    --     watchdog in 00503 that does not depend on HTTP observation at all.
    OR (oks = 0 AND timeouts >= c_min_hard);

  SELECT string_agg(jobname, ',' ORDER BY jobname),
         string_agg(jobname || ' (' || failures || 'x ' || codes || ')', ' - ' ORDER BY jobname)
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
            || '<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_fail.failures || 'x ' || v_fail.codes || '</td></tr>'
            || '<tr><td colspan="2" style="padding:2px 6px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px">'
            || coalesce(replace(replace(v_fail.sample,'<','&lt;'),'>','&gt;'), '') || '</td></tr>';
        END LOOP;
        v_subject := '[TriciGo] Cron -> Edge Function fallando';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Cron -> Edge Function fallando</h2>'
          || '<p>Estas llamadas HTTP de cron respondieron mal (o no respondieron nunca) en los ultimos '
          || c_window_min || ' min. <b>pg_cron las reporta como &laquo;succeeded&raquo;</b> - solo se ven aca.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
          || '<p><b>Que revisar:</b> los logs de la Edge Function correspondiente. '
          || 'Un timeout suelto entre respuestas OK NO alerta: pg_net deja de esperar a los 5s pero la funcion sigue corriendo.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico de crons HTTP. No responder.</p></body></html>';
      ELSE
        v_subject := '[TriciGo] Cron -> Edge Function recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Crons recuperados</h2>'
          || '<p>Todas las llamadas HTTP de cron vuelven a responder lo esperado.</p>'
          || '<p style="color:#777;font-size:12px">Anterior: ' || COALESCE(v_prev,'-') || '</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico de crons HTTP. No responder.</p></body></html>';
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
  RAISE WARNING 'check_cron_http_failures failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_cron_http_failures() IS
  '00509: alerts on a job that ANSWERED badly (>=2 non-2xx) or went completely silent '
  '(zero successes in the window). A lone pg_net timeout among successes is NOT a failure - '
  'pg_net stops waiting at its timeout while the Edge Function keeps running and completes.';
