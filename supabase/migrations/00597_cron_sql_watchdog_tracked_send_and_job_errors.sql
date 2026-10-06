-- ============================================================
-- 00597: the SQL-cron watchdog (00596) sends through cron_http_post, and
--        counts a failed run only when the job itself failed
--
-- Two changes to the 00596 functions. Both patch the live body in place
-- (pg_get_functiondef + replace), so nothing else in them can change, and both
-- check the text they replace first: if prod's body is no longer 00596's, the
-- migration aborts instead of patching something else.
--
-- 1. check_cron_sql_failures() sends through cron_http_post.
--    It called send_db_health_email(), which uses net.http_post directly.
--    net.http_post only queues the request and nothing read the responses to
--    those, so an email that send-email rejected (401 without the vault key,
--    any 5xx, its 429 rate limit) was lost without a trace. The repo rule is
--    that cron-driven calls to an Edge Function go through cron_http_post.
--    Each recipient's email is now cron_http_post('cron-sql-failure-alert',
--    ...). check_cron_http_failures reports the label when 2 or more of those
--    calls are rejected inside its 90-minute window: one alert to prod's 5
--    recipients is enough, a single rejected recipient is not. If the
--    rejection is systemic (no vault key, send-email down), that watchdog's
--    own emails fail the same way, so the trace to read is cron_http_calls
--    (24 h), net._http_response (6 h) and platform_config.cron_http_health_*.
--    Recipients, subject, body, headers and guards are the ones
--    send_db_health_email used. The one difference is the HTTP timeout:
--    cron_http_post waits 30 s where net.http_post's default is 5 s, which
--    00509 found records calls that did succeed as timeouts.
--    send_db_health_email itself is not touched: check_database_health and the
--    daily digest still use it.
--
-- 2. cron_sql_failures_now() counts a failed run only when the job failed.
--    It skipped exactly two messages, 'job startup timeout' and 'server
--    restarted', and counted every other failed run as the job's. pg_cron runs
--    in libpq mode here (cron.use_background_workers = off), and its source
--    (src/pg_cron.c) records more failures where it could not run the job or
--    lost its connection while it ran: 'connection failed', 'connection lost',
--    'job canceled'. Now a failed run counts only if the job's SQL raised
--    (return_message starts with 'ERROR:', in libpq's format and in the
--    background worker's) or pg_cron refused the job's command ('COPY not
--    supported', the one pg_cron message that is the job's fault). Every other
--    failure is skipped, the way 00596 skipped its two. The rest of 00596's
--    rule is unchanged: 3 in a row, confirmed at two consecutive checks.
--    Known gap, accepted: a job that dies at FATAL level on every run (its
--    backend terminated, a transaction_timeout) or whose role or database no
--    longer exists ('connection failed') is skipped too. Neither happens here,
--    and in cron.job_run_details both look like the platform.
--    On prod's 14 days of history (2026-09-25) every failed run is one of
--    00596's two messages or starts with 'ERROR:', so today this changes no
--    result. What it prevents is the next outage looking like a broken job.
--
-- Rehearsal: supabase/tests/00597/run.sh.
-- ============================================================

DO $patch$
DECLARE
  v_src   text;
  v_new   text;
  -- 2. cron_sql_failures_now(): which failed runs count
  v_a_decl_old text := $a_decl_old$  c_outage_msgs constant text[]  := ARRAY['job startup timeout', 'server restarted'];
$a_decl_old$;
  v_a_cond_old text := $a_cond_old$      AND NOT (d.status = 'failed' AND d.return_message = ANY (c_outage_msgs))
$a_cond_old$;
  v_a_cond_new text := $a_cond_new$      -- 00597: a failed run counts only if the job's SQL raised ('ERROR: ...') or
      -- pg_cron refused its command ('COPY not supported'). Any other failure is
      -- pg_cron not being able to run the job, or losing its connection while it
      -- ran (job startup timeout, server restarted, connection failed,
      -- connection lost, job canceled).
      AND (d.status = 'succeeded'
           OR COALESCE(d.return_message, '') LIKE 'ERROR:%'
           OR d.return_message = 'COPY not supported')
$a_cond_new$;
  -- 1. check_cron_sql_failures(): how the alert is sent
  v_b_old text := $b_old$    -- Shared ops mailer from 00577: every address in business_notification_email,
    -- and it refuses to send a blank body.
    v_sent := send_db_health_email(v_subject, v_html);
$b_old$;
  v_b_new text := $b_new$    -- 00597: every address in business_notification_email gets its email
    -- through cron_http_post, so a send that send-email rejects shows up in
    -- check_cron_http_failures. Same guards as send_db_health_email, which this
    -- used to call: no recipients, no email; a blank body is refused.
    DECLARE
      v_to_raw      text;
      v_rcpt        text;
      v_service_key text;
      v_headers     jsonb;
    BEGIN
      SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
      IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
        NULL;
      ELSIF v_html IS NULL OR btrim(v_html) = '' OR v_subject IS NULL THEN
        RAISE WARNING 'check_cron_sql_failures: cuerpo vacío, no se envía (subject=%)', v_subject;
      ELSE
        v_service_key := get_service_role_key();
        v_headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key);
        FOR v_rcpt IN
          SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
        LOOP
          PERFORM public.cron_http_post('cron-sql-failure-alert',
            url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
            headers := v_headers,
            body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject,
                                          -- Raw HTML, accepted by send-email's legacy path.
                                          'template', v_html, 'data', '{}'::jsonb));
          v_sent := v_sent + 1;
        END LOOP;
      END IF;
    END;
$b_new$;
BEGIN
  -- ── cron_sql_failures_now() ──
  v_src := pg_get_functiondef('public.cron_sql_failures_now()'::regprocedure);
  IF position($m$00597: a failed run counts only if the job's SQL raised$m$ IN v_src) > 0 THEN
    RAISE NOTICE '00597: cron_sql_failures_now() already patched';
  ELSIF (length(v_src) - length(replace(v_src, v_a_decl_old, ''))) / length(v_a_decl_old) <> 1
     OR (length(v_src) - length(replace(v_src, v_a_cond_old, ''))) / length(v_a_cond_old) <> 1 THEN
    IF position(E'\r' IN v_a_decl_old) > 0 THEN
      RAISE EXCEPTION '00597: this file was read with CRLF line endings, so its patch targets cannot match the function; apply it with LF';
    END IF;
    RAISE EXCEPTION '00597: cron_sql_failures_now() is not the 00596 body this patches; not touching it';
  ELSE
    v_new := replace(replace(v_src, v_a_decl_old, ''), v_a_cond_old, v_a_cond_new);
    EXECUTE v_new;
  END IF;

  -- ── check_cron_sql_failures() ──
  v_src := pg_get_functiondef('public.check_cron_sql_failures()'::regprocedure);
  IF position($m$cron_http_post('cron-sql-failure-alert',$m$ IN v_src) > 0 THEN
    RAISE NOTICE '00597: check_cron_sql_failures() already patched';
  ELSIF (length(v_src) - length(replace(v_src, v_b_old, ''))) / length(v_b_old) <> 1 THEN
    IF position(E'\r' IN v_b_old) > 0 THEN
      RAISE EXCEPTION '00597: this file was read with CRLF line endings, so its patch targets cannot match the function; apply it with LF';
    END IF;
    RAISE EXCEPTION '00597: check_cron_sql_failures() is not the 00596 body this patches; not touching it';
  ELSE
    EXECUTE replace(v_src, v_b_old, v_b_new);
  END IF;

  -- Both landed, and neither old text is left.
  v_src := pg_get_functiondef('public.cron_sql_failures_now()'::regprocedure);
  IF position($m$00597: a failed run counts only if the job's SQL raised$m$ IN v_src) = 0 OR position('c_outage_msgs' IN v_src) > 0 THEN
    RAISE EXCEPTION '00597: the cron_sql_failures_now() patch did not land';
  END IF;
  v_src := pg_get_functiondef('public.check_cron_sql_failures()'::regprocedure);
  IF position($m$cron_http_post('cron-sql-failure-alert',$m$ IN v_src) = 0 OR position('send_db_health_email(' IN v_src) > 0 THEN
    RAISE EXCEPTION '00597: the check_cron_sql_failures() patch did not land';
  END IF;
END $patch$;

-- Self-test, as 00596 did: plpgsql only checks a body when it runs, and the
-- email path only runs on a change. Force one inside a subtransaction (a
-- made-up job that "was reported", plus whatever fails now), check that every
-- recipient's email went out through cron_http_post, then undo everything:
-- the state, the queued emails and their cron_http_calls rows (all
-- transactional). This also runs the patched rule over the live history.
DO $selftest$
DECLARE
  v_expected integer;
  v_before   bigint;
  v_found    jsonb;
  v_result   jsonb;
  v_queued   integer;
  v_tracked  integer;
  v_blank    integer;
BEGIN
  SELECT count(*) INTO v_expected
  FROM public.platform_config pc,
       unnest(string_to_array(pc.value #>> '{}', ',')) AS r(x)
  WHERE pc.key = 'business_notification_email' AND position('@' IN r.x) > 0;

  BEGIN
    v_found := public.cron_sql_failures_now();
    INSERT INTO public.platform_config (key, value) VALUES
      ('cron_sql_health_signature',  '["00597-self-test"]'::jsonb),
      ('cron_sql_health_candidates', (SELECT COALESCE(jsonb_agg(e ->> 'job'), '[]'::jsonb)
                                      FROM jsonb_array_elements(v_found) AS e))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

    SELECT COALESCE(max(q.id), 0) INTO v_before FROM net.http_request_queue q;
    v_result := public.check_cron_sql_failures();

    -- pg_net stores the request body as bytea. Only this watchdog's emails
    -- (its subjects all name "tareas programadas"): another session may queue
    -- one of its own meanwhile.
    SELECT count(*),
           count(*) FILTER (WHERE c.jobname = 'cron-sql-failure-alert'),
           count(*) FILTER (WHERE btrim(COALESCE(convert_from(q.body, 'UTF8')::jsonb ->> 'template', '')) = '')
      INTO v_queued, v_tracked, v_blank
    FROM net.http_request_queue q
    LEFT JOIN public.cron_http_calls c ON c.request_id = q.id
    WHERE q.id > v_before
      AND q.url LIKE '%/functions/v1/send-email'
      AND convert_from(q.body, 'UTF8')::jsonb ->> 'subject' ILIKE '%tarea%programada%';
    RAISE EXCEPTION '00597 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00597 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF jsonb_typeof(v_found) IS DISTINCT FROM 'array'
     OR (v_result ->> 'emails_sent')::integer IS DISTINCT FROM v_expected
     OR v_queued IS DISTINCT FROM v_expected
     OR v_tracked IS DISTINCT FROM v_expected
     OR v_blank <> 0 THEN
    RAISE EXCEPTION '00597: the check queued % emails (% through cron_http_post, % blank) for % recipients: %',
      v_queued, v_tracked, v_blank, v_expected, v_result;
  END IF;
  RAISE NOTICE '00597: verified, a change emails all % recipients through cron_http_post (%)',
    v_expected, v_result ->> 'status';
END $selftest$;
