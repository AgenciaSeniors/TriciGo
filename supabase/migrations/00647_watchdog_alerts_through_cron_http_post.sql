-- ============================================================
-- Migration 00647: watchdog alert e-mails go through cron_http_post
--
-- Four watchdog e-mail paths sent their alert with a raw net.http_post to the
-- send-email Edge Function:
--   check_cron_http_failures        (cron check-cron-http-failures)
--   check_exchange_rate_freshness   (cron check-exchange-rate-freshness)
--   check_poi_sync_freshness        (cron check-poi-sync-freshness)
--   send_db_health_email            (used by check_database_health and
--                                    send_db_health_digest)
-- A raw net.http_post leaves no row in cron_http_calls. When send-email rejected
-- the alert (no Resend key, send-email down, any 4xx/5xx), check_cron_http_failures
-- never saw it and the alert was lost without a trace. 00597 fixed the same thing
-- for check_cron_sql_failures (label cron-sql-failure-alert).
--
-- Measured in prod on 2026-10-08 (read only): these four are the only functions
-- that a cron job reaches, directly or through a function it calls, with a raw
-- net.http_post. The bodies are the ones 00640 left (no outer EXCEPTION handler).
--
-- What changes, in place on the live bodies (pg_get_functiondef + replace), one
-- label per function:
--   PERFORM net.http_post(   ->   PERFORM public.cron_http_post('<label>',
--     check_cron_http_failures        cron-http-failure-alert
--     check_exchange_rate_freshness   fx-stale-alert        (also its recovery e-mail)
--     check_poi_sync_freshness        poi-sync-stale-alert  (also its recovery e-mail)
--     send_db_health_email            db-health-email       (transition alerts and the daily digest)
-- The named arguments stay the same; cron_http_post takes the same names. The URL,
-- headers and body sent to send-email do not change. The timeout goes from
-- net.http_post's 5 s to cron_http_post's 30 s, as in 00597. send-email answers 200
-- when Resend accepts the e-mail and 4xx/5xx otherwise, so no
-- cron_http_expectations row is needed. Each body must have the md5 read from prod
-- on 2026-10-08, or already be patched; any other body aborts the migration.
--
-- What this does and does not give:
--   * A rejected alert now shows in check_cron_http_failures' next hourly review,
--     in platform_config.cron_http_health_* and in cron_http_calls (24 h) /
--     net._http_response (6 h). The review needs 2 or more failures of a label in
--     90 minutes. Each alert goes to every address in business_notification_email
--     (4 or 5 today), so one rejected alert is enough; with a single address it
--     would take two.
--   * The alerts are a burst, one request per address, and send-email does not
--     retry. Measured on 2026-10-07/08 (function_edge_logs): 9 bursts of 3 to 5
--     send-email calls in the same minute, all answered 200, so Resend's rate limit
--     does not reject part of a burst today.
--   * If send-email itself is down, the review's own e-mail fails too: the trace is
--     what is gained, not a delivered e-mail. While send-email stays down, the
--     review's own label (cron-http-failure-alert) enters and leaves its failing set
--     as its last calls age out of the 90-minute window, so it retries its e-mail
--     about twice every 3 hours, and between retries cron_http_health_status can say
--     "ok" although the outage goes on. Nobody receives those e-mails, because
--     send-email is down.
--   * A missing vault key makes get_service_role_key() raise before any request:
--     since 00640 that fails the cron run, which check_cron_sql_failures reports.
--
-- Left out on purpose: the user-facing transactional senders that also use a raw
-- net.http_post to send-email (receipts, payouts, first ride, trusted contacts,
-- driver status, cargo bonus, payment failed, delivery receipt), the driver
-- under-review notice, and notify_ops_workflow_failure (called by GitHub
-- workflows, not by pg_cron). None of them is a cron watchdog.
--
-- Only pg_cron calls these functions (send_db_health_email through the two db
-- health functions); only service_role can execute them, and that does not change.
-- No new table: no GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- The patch texts are ASCII, so pasting this file with CRLF line endings does not
-- change what is matched.
-- ============================================================

DO $patch$
DECLARE
  r      record;
  v_oid  oid;
  v_md5  text;
  v_src  text;
  v_def  text;
  v_old  constant text := 'PERFORM net.http_post(';
  v_new  text;
BEGIN
  IF to_regprocedure('public.cron_http_post(text,text,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION '00647: public.cron_http_post(text,text,jsonb,jsonb,integer) is missing';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('public.check_cron_http_failures()', 'cron-http-failure-alert',
       '3bcacc073b307c74b8ef7e137865de32', '2afcc2be8700867913f7a6c00c73bc22'),
      ('public.check_exchange_rate_freshness()', 'fx-stale-alert',
       '658b8be4592ab74821ee0df845579437', 'fb984eeaf3c688c11d35b6e31b831914'),
      ('public.check_poi_sync_freshness()', 'poi-sync-stale-alert',
       'c9434e9e1c75a6504f84de2074369a88', 'fdd8db5c1cd35cb8f91dd65b2447cd67'),
      ('public.send_db_health_email(text,text)', 'db-health-email',
       '4b9ed06fabc6d67a8f4666945fafd0a9', '1358c35561353f2bb514e3da6614e363')
    ) AS t(fn, label, md5_live, md5_new)
  LOOP
    v_oid := to_regprocedure(r.fn);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '00647: % is missing', r.fn;
    END IF;

    SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = v_oid;
    CONTINUE WHEN v_md5 = r.md5_new;   -- already patched (second run)
    IF v_md5 <> r.md5_live THEN
      RAISE EXCEPTION '00647: % has a body this migration does not know (md5 %), refusing to patch it', r.fn, v_md5;
    END IF;

    v_def := pg_get_functiondef(v_oid);
    IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1
       OR (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '00647: the text to patch in % does not appear exactly once', r.fn;
    END IF;

    v_new := 'PERFORM public.cron_http_post(' || quote_literal(r.label) || ',';
    EXECUTE replace(v_def, v_old, v_new);

    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
    IF v_md5 <> r.md5_new THEN
      RAISE EXCEPTION '00647: % was patched to md5 %, expected %', r.fn, v_md5, r.md5_new;
    END IF;
  END LOOP;
END
$patch$;

-- Self-checks: the migration asserts its own result instead of trusting it.
DO $check$
DECLARE
  r        record;
  v_src    text;
  v_bad    text;
  v_probe  text;
  c_rcpt   constant text := 'zz-00647-probe@example.invalid';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.check_cron_http_failures()', 'check_cron_http_failures', 'cron-http-failure-alert'),
      ('public.check_exchange_rate_freshness()', 'check_exchange_rate_freshness', 'fx-stale-alert'),
      ('public.check_poi_sync_freshness()', 'check_poi_sync_freshness', 'poi-sync-stale-alert'),
      ('public.send_db_health_email(text,text)', 'send_db_health_email', 'db-health-email')
    ) AS t(fn, name, label)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(r.fn);
    IF v_src ~ 'net\.http_post\s*\(' THEN
      RAISE EXCEPTION '00647: % still sends through a raw net.http_post', r.name;
    END IF;
    IF (SELECT count(*) FROM regexp_matches(v_src, 'public\.cron_http_post\s*\(', 'g')) <> 1
       OR position('public.cron_http_post(' || quote_literal(r.label) || ',' IN v_src) = 0 THEN
      RAISE EXCEPTION '00647: % must call public.cron_http_post once, with label %', r.name, r.label;
    END IF;
  END LOOP;

  -- No cron job reaches a raw net.http_post any more, directly or through one
  -- function it calls (the wrapper cron_http_post itself aside).
  WITH direct AS (
    SELECT DISTINCT j.jobname, p.oid, p.proname, p.prosrc
    FROM cron.job j
    JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace
                  AND j.command ~ ('\m' || p.proname || '\s*\(')
  ), reached AS (
    SELECT d.jobname, d.proname AS via, d.prosrc FROM direct d
    UNION
    SELECT d.jobname, c.proname, c.prosrc
    FROM direct d
    JOIN pg_proc c ON c.pronamespace = 'public'::regnamespace AND c.oid <> d.oid
                  AND d.prosrc ~ ('\m' || c.proname || '\s*\(')
  )
  SELECT string_agg(DISTINCT jobname || ' via ' || via, ', ') INTO v_bad
  FROM (
    SELECT jobname, via FROM reached
    WHERE via <> 'cron_http_post' AND prosrc ~ 'net\.http_post\s*\('
    UNION
    SELECT jobname, '(its command)' FROM cron.job WHERE command ~ 'net\.http_post\s*\('
  ) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00647: cron jobs still reach a raw net.http_post: %', v_bad;
  END IF;

  -- Probe: each function sends its e-mail and the request lands in cron_http_calls
  -- with its label and a 30 s timeout. One fake recipient; every watchdog forced
  -- into a transition. net.http_request_queue is transactional, so the final RAISE
  -- cancels the four requests along with everything else written here.
  BEGIN
    INSERT INTO public.platform_config (key, value) VALUES
      ('business_notification_email', to_jsonb(c_rcpt)),
      ('cron_http_health_signature',  to_jsonb('zz_00647_probe'::text)),
      ('fx_stale_alert_hours',        to_jsonb(-1)),
      ('fx_health_status',            to_jsonb('ok'::text)),
      ('poi_sync_stale_alert_hours',  to_jsonb(-1)),
      ('poi_sync_health_status',      to_jsonb('ok'::text))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

    PERFORM public.check_cron_http_failures();
    PERFORM public.check_exchange_rate_freshness();
    PERFORM public.check_poi_sync_freshness();
    PERFORM public.send_db_health_email('zz 00647 probe', '<p>zz 00647 probe</p>');

    SELECT string_agg(c.jobname || ':' || q.timeout_milliseconds || ':'
                      || (convert_from(q.body, 'UTF8')::jsonb ->> 'recipient_email'), ',' ORDER BY c.jobname COLLATE "C")
      INTO v_probe
    FROM public.cron_http_calls c
    JOIN net.http_request_queue q ON q.id = c.request_id
    WHERE c.called_at = now();

    RAISE EXCEPTION 'zz_00647_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'zz_00647_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_probe IS DISTINCT FROM
       'cron-http-failure-alert:30000:' || c_rcpt || ',db-health-email:30000:' || c_rcpt
       || ',fx-stale-alert:30000:' || c_rcpt || ',poi-sync-stale-alert:30000:' || c_rcpt THEN
    RAISE EXCEPTION '00647: probe failed, the labeled calls were [%]', COALESCE(v_probe, 'none');
  END IF;
END
$check$;
