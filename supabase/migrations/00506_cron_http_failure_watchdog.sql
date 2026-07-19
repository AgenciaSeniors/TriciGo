-- 00506: Make cron -> Edge Function failures visible.
--
-- THE BLIND SPOT
-- Seven cron jobs invoke an Edge Function with `SELECT net.http_post(...)`. That
-- only ENQUEUES the request and returns a request_id, so cron.job_run_details
-- records the result of the SELECT — always 'succeeded' — and never the HTTP
-- outcome. Proven during the 2026-07-15 FX outage: runid 608668 finished in 36ms
-- with status='succeeded' while net._http_response id 77583 held status_code=502
-- for that same second. 91 consecutive green runs while the function failed every
-- single time, and the exchange rate sat frozen for four days.
--
-- WHY ATTRIBUTION NEEDS A HELPER
-- net._http_response has NO url column, and net.http_request_queue (which does)
-- is a queue whose rows are deleted once processed. So after the fact there is no
-- way to join a failing response back to the job that made it. The mapping has to
-- be recorded at call time — hence cron_http_post() below.
--
-- WHY THE CRON REWRITE IS A TEXTUAL SUBSTITUTION
-- The seven commands carry two different auth shapes (hardcoded anon JWT + vault
-- service_role for 22-25; get_service_role_key() for 33-35). Retyping those
-- headers is seven chances to silently break a job. Instead cron_http_post()
-- takes the SAME named arguments as net.http_post, so each command changes by a
-- pure prefix substitution that leaves headers and body byte-identical:
--     SELECT net.http_post(url := ..., headers := ..., body := ...)
--  -> SELECT public.cron_http_post('<jobname>', url := ..., headers := ..., body := ...)

-- ── Call log: request_id -> which job made it ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_http_calls (
  request_id bigint      PRIMARY KEY,
  jobname    text        NOT NULL,
  url        text        NOT NULL,
  called_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cron_http_calls_called_at_idx
  ON public.cron_http_calls (called_at DESC);

COMMENT ON TABLE public.cron_http_calls IS
  '00506: maps a pg_net request_id to the cron job that issued it, because '
  'net._http_response has no url and net.http_request_queue is drained on completion. '
  'Pruned to 24h by check_cron_http_failures().';

-- ── Per-job expected statuses ────────────────────────────────────────────────
-- Anything not listed here is expected to return 2xx.
CREATE TABLE IF NOT EXISTS public.cron_http_expectations (
  jobname     text  PRIMARY KEY,
  ok_statuses int[] NOT NULL,
  note        text
);

-- The two keepwarm jobs deliberately present no credentials: their only purpose
-- is to boot the Edge Function's isolate, and a 401 proves it booted and replied.
-- Treating that as a failure would alert every two minutes forever. A 5xx or a
-- timeout on those jobs IS still a real failure and still alerts.
INSERT INTO public.cron_http_expectations (jobname, ok_statuses, note) VALUES
  ('keepwarm-netopia-create-intent', ARRAY[200,401], '401 is by design — the probe carries no user JWT; it only warms the isolate'),
  ('keepwarm-netopia-mint',          ARRAY[200,401], '401 is by design — see above')
ON CONFLICT (jobname) DO NOTHING;

-- ── Instrumented wrapper around net.http_post ────────────────────────────────
CREATE OR REPLACE FUNCTION public.cron_http_post(
  p_jobname            text,
  url                  text,
  headers              jsonb DEFAULT '{}'::jsonb,
  body                 jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;      -- copy into locals: the parameters are named to
  v_headers jsonb := headers; -- match net.http_post's, which would otherwise
  v_body    jsonb := body;    -- shadow the target columns in the INSERT below
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  -- Fire FIRST, log second. If the bookkeeping ever fails, the request has
  -- already been enqueued and its id is still returned — the job degrades to
  -- "untracked", never to "not sent". This wrapper must not be able to break
  -- the seven jobs it instruments.
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

REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;

-- ── Reconciler: join the log to the responses and alert on transitions ───────
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
  r             RECORD;
  v_sent        integer := 0;
BEGIN
  CREATE TEMP TABLE _fails ON COMMIT DROP AS
  SELECT c.jobname,
         count(*)                                                   AS failures,
         count(*) FILTER (WHERE r.status_code IS NULL)               AS timeouts,
         string_agg(DISTINCT COALESCE(r.status_code::text, 'timeout'), '/' ORDER BY COALESCE(r.status_code::text,'timeout')) AS codes,
         max(left(COALESCE(r.content, r.error_msg, ''), 120))        AS sample
  FROM public.cron_http_calls c
  JOIN net._http_response r ON r.id = c.request_id
  LEFT JOIN public.cron_http_expectations e ON e.jobname = c.jobname
  WHERE c.called_at >  now() - make_interval(mins => c_window_min)
    AND c.called_at <  now() - make_interval(secs => c_grace_sec)
    AND (r.status_code IS NULL
         OR NOT (r.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204]))))
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
        FOR r IN SELECT * FROM _fails ORDER BY jobname LOOP
          v_rows := v_rows
            || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>' || r.jobname || '</b></td>'
            || '<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || r.failures || '× ' || r.codes || '</td></tr>'
            || '<tr><td colspan="2" style="padding:2px 6px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px">'
            || coalesce(replace(replace(r.sample,'<','&lt;'),'>','&gt;'), '') || '</td></tr>';
        END LOOP;
        v_subject := '[TriciGo] Cron -> Edge Function fallando';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Cron → Edge Function fallando</h2>'
          || '<p>Estas llamadas HTTP de cron devolvieron un estado inesperado en los últimos '
          || c_window_min || ' min. <b>pg_cron las reporta como &laquo;succeeded&raquo;</b> — solo se ven acá.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
          || '<p><b>Qué revisar:</b> los logs de la Edge Function correspondiente. '
          || 'Detalle completo: <code>SELECT * FROM cron_http_calls c JOIN net._http_response r ON r.id=c.request_id '
          || 'WHERE c.called_at &gt; now() - interval ''2 hours'' AND r.status_code &lt;&gt; 200;</code></p>'
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

COMMENT ON FUNCTION public.check_cron_http_failures() IS
  '00506: reconciles cron_http_calls against net._http_response and emails on a change '
  'in the set of failing jobs. Closes the pg_cron blind spot that hid the 2026-07-15 FX outage.';

REVOKE ALL ON FUNCTION public.check_cron_http_failures() FROM PUBLIC, anon, authenticated;

-- ── Point the seven jobs at the wrapper (pure textual prefix substitution) ────
DO $rewire$
DECLARE r RECORD; v_new text;
BEGIN
  FOR r IN
    SELECT jobid, jobname, command FROM cron.job
    WHERE command LIKE '%net.http_post(%'
      AND command NOT LIKE '%cron_http_post(%'          -- idempotent
      AND jobname <> 'check-cron-http-failures'          -- never instrument the watchdog itself
  LOOP
    v_new := replace(r.command, 'net.http_post(',
                     'public.cron_http_post(' || quote_literal(r.jobname) || ', ');
    PERFORM cron.alter_job(job_id := r.jobid, command := v_new);
    RAISE NOTICE '00506: instrumented cron % (%)', r.jobname, r.jobid;
  END LOOP;
END $rewire$;

-- ── Schedule the reconciler (pure SQL — it cannot inherit the blind spot) ────
SELECT cron.unschedule('check-cron-http-failures')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-cron-http-failures');

SELECT cron.schedule('check-cron-http-failures', '40 * * * *',
                     $cron$SELECT public.check_cron_http_failures();$cron$);
