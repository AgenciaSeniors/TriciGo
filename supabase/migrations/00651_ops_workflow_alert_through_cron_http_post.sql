-- ============================================================
-- Migration 00651: the failed-workflow alert goes through cron_http_post
--
-- notify_ops_workflow_failure is what sync-pois.yml and sync-osm-delta.yml call
-- (POST /rest/v1/rpc/notify_ops_workflow_failure, service key) when the run fails.
-- It sent its e-mail with a raw net.http_post to the send-email Edge Function. A
-- raw net.http_post leaves no row in cron_http_calls, so when send-email rejected
-- the alert (no Resend key, send-email down, any 4xx/5xx) check_cron_http_failures
-- never saw it and the alert was lost without a trace. 00597 and 00647 fixed the
-- same thing for the cron watchdogs; this one is not a cron job, but it is an ops
-- alert with the same blind spot.
--
-- What changes, in place on the live body (pg_get_functiondef + replace):
--   PERFORM net.http_post(   ->   PERFORM public.cron_http_post('ops-workflow-alert',
-- The named arguments stay the same; cron_http_post takes the same names. The URL,
-- headers and body sent to send-email do not change, nor do the 6 h cooldown per
-- workflow, the escaping, the signature or the grants. The timeout goes from
-- net.http_post's 5 s to cron_http_post's 30 s, as in 00597 and 00647. send-email
-- answers 200 when Resend accepts the e-mail and 4xx/5xx otherwise, so no
-- cron_http_expectations row is needed. The body must have the md5 read from prod
-- on 2026-10-11, or already be patched; any other body aborts the migration.
--
-- What this does and does not give:
--   * A rejected alert now shows in check_cron_http_failures' next hourly review
--     (2 or more failures of the label in 90 minutes; each alert goes to every
--     address in business_notification_email, 4 or 5 today), in
--     platform_config.cron_http_health_* and in cron_http_calls (24 h) /
--     net._http_response (6 h).
--   * If send-email itself is down, the review's own e-mail fails too: the trace is
--     what is gained, not a delivered e-mail.
--   * If the database is down, the workflow cannot call this function at all; that
--     case belongs to supabase-uptime.yml, not to this alert.
--   * The function keeps its outer EXCEPTION handler: it answers {"ok": false} to
--     the workflow instead of an HTTP error. Its callers already ignore failures
--     (`|| echo "::warning::..."`), so this migration leaves that alone.
--
-- Only service_role can execute it, and that does not change.
-- No new table: no GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- The patch texts are ASCII, so pasting this file with CRLF line endings does not
-- change what is matched.
-- ============================================================

DO $patch$
DECLARE
  c_fn       constant text := 'public.notify_ops_workflow_failure(text,text,text)';
  c_label    constant text := 'ops-workflow-alert';
  c_md5_live constant text := 'c8b27cf11345251e309c561b77516506';
  c_md5_new  constant text := 'e0951f901595cd556c019a65fd316a57';
  c_old      constant text := 'PERFORM net.http_post(';
  v_oid  oid;
  v_md5  text;
  v_src  text;
  v_def  text;
BEGIN
  IF to_regprocedure('public.cron_http_post(text,text,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION '00651: public.cron_http_post(text,text,jsonb,jsonb,integer) is missing';
  END IF;

  v_oid := to_regprocedure(c_fn);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '00651: % is missing', c_fn;
  END IF;

  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = v_oid;
  IF v_md5 = c_md5_new THEN
    RETURN;   -- already patched (second run)
  END IF;
  IF v_md5 <> c_md5_live THEN
    RAISE EXCEPTION '00651: notify_ops_workflow_failure has a body this migration does not know (md5 %), refusing to patch it', v_md5;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  IF (length(v_src) - length(replace(v_src, c_old, ''))) / length(c_old) <> 1
     OR (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION '00651: the text to patch in notify_ops_workflow_failure does not appear exactly once';
  END IF;

  EXECUTE replace(v_def, c_old, 'PERFORM public.cron_http_post(' || quote_literal(c_label) || ',');

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_md5_new THEN
    RAISE EXCEPTION '00651: notify_ops_workflow_failure was patched to md5 %, expected %', v_md5, c_md5_new;
  END IF;
END
$patch$;

-- Self-checks: the migration asserts its own result instead of trusting it.
DO $check$
DECLARE
  c_expected constant text := 'ops-workflow-alert';
  c_rcpt     constant text := 'zz-00651-probe@example.invalid';
  c_oid      constant oid  := 'public.notify_ops_workflow_failure(text,text,text)'::regprocedure;
  v_src    text;
  v_result jsonb;
  v_probe  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_oid;
  IF v_src ~ 'net\.http_post\s*\(' THEN
    RAISE EXCEPTION '00651: notify_ops_workflow_failure still sends through a raw net.http_post';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_src, 'public\.cron_http_post\s*\(', 'g')) <> 1
     OR position('public.cron_http_post(' || quote_literal(c_expected) || ',' IN v_src) = 0 THEN
    RAISE EXCEPTION '00651: notify_ops_workflow_failure must call public.cron_http_post once, with label %', c_expected;
  END IF;
  IF has_function_privilege('anon', c_oid, 'EXECUTE') OR has_function_privilege('authenticated', c_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', c_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '00651: notify_ops_workflow_failure grants changed';
  END IF;

  -- Probe: the function sends its e-mail and the request lands in cron_http_calls
  -- with its label and a 30 s timeout. One fake recipient and a workflow name with
  -- no cooldown. net.http_request_queue is transactional, so the final RAISE cancels
  -- the request along with everything else written here (the cooldown stamp too).
  BEGIN
    INSERT INTO public.platform_config (key, value)
    VALUES ('business_notification_email', to_jsonb(c_rcpt))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

    v_result := public.notify_ops_workflow_failure(
      'zz-00651-probe', 'https://github.com/AgenciaSeniors/TriciGo/actions/runs/0', 'zz 00651 probe');

    SELECT string_agg(c.jobname || ':' || q.timeout_milliseconds || ':'
                      || (convert_from(q.body, 'UTF8')::jsonb ->> 'recipient_email'), ',' ORDER BY c.jobname COLLATE "C")
      INTO v_probe
    FROM public.cron_http_calls c
    JOIN net.http_request_queue q ON q.id = c.request_id
    WHERE c.called_at = now();

    RAISE EXCEPTION 'zz_00651_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'zz_00651_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  -- The function swallows its own errors, so its result is checked too.
  IF v_result ->> 'ok' IS DISTINCT FROM 'true' OR v_result ->> 'emails_sent' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION '00651: probe failed, the function returned %', v_result;
  END IF;
  IF v_probe IS DISTINCT FROM c_expected || ':30000:' || c_rcpt THEN
    RAISE EXCEPTION '00651: probe failed, the labeled calls were [%]', COALESCE(v_probe, 'none');
  END IF;
END
$check$;
