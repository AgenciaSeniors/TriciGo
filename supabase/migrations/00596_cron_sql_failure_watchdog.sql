-- ============================================================
-- 00596: email when a pure-SQL cron job keeps failing
--
-- check_cron_http_failures (00506/00507/00509) watches the crons that call an
-- Edge Function. Nothing watched the others. cleanup_auth_revocations (jobid
-- 28, 03:00 UTC) had not succeeded once since 2026-07-11: all 14 runs still
-- on record failed with "query returned more than one row", and nobody
-- noticed for two and a half months (fixed in 00594). This closes that gap
-- for every current and future SQL job.
--
-- What counts as failing. Runs come from cron.job_run_details, which keeps 14
-- days (prune-cron-run-details, 00576). A job is failing when its latest real
-- failures in a row reach 3, or cover every run it has in the window when it
-- has run fewer than 3 times (a weekly job, a job created this week). Two
-- pg_cron messages are not the job's fault and are skipped, neither counted
-- nor breaking a streak: "job startup timeout" and "server restarted". Those
-- are Supabase outages (2,414 runs on 2026-09-18/20/21, 3 on the Micro upgrade
-- of 09-22), and the external uptime watchdogs already report them
-- (ops/supabase-watchdog, .github/workflows/supabase-uptime.yml).
--
-- Why a job must be seen failing at two checks in a row. During those
-- outages the minute-level retry-dispatch-expired-rides also hit statement
-- timeouts, three and four in a row at the 10:45 checks of 09-20 and 09-21,
-- and recovered before the next hour. Replayed hour by hour against the run
-- history in prod (265 checks, 2026-09-14 to 09-25), alerting on the first
-- sighting would have sent 5 emails, 4 of them false alarms; requiring the
-- second sends exactly one, for cleanup_auth_revocations. A job that stays
-- broken costs one hour more.
--
-- Alerts. One email to business_notification_email when the set of failing
-- jobs changes: a job that stays broken does not repeat, a newly broken job
-- alerts even while another is down, and recovery sends one more. Same pattern
-- and mailer as check_database_health (00577). State lives in platform_config:
-- cron_sql_health_status / _signature / _candidates / _detail / _at.
--
-- Pure SQL, like 00503 and 00577: an Edge Function invoked through
-- net.http_post would be as blind as the jobs it watched. The only HTTP call is
-- the email, which is the action, not the detection. The check has no
-- EXCEPTION WHEN OTHERS on purpose: if it ever breaks, its own run must show
-- up as failed in cron.job_run_details instead of reporting success.
-- Rehearsal: supabase/tests/00596/run.sh.
-- ============================================================

-- Read-only: what is failing right now, one object per job. The check and the
-- migration's seed below both use it, so they cannot disagree, and
-- `SELECT public.cron_sql_failures_now();` answers the question by hand.
CREATE OR REPLACE FUNCTION public.cron_sql_failures_now()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_window_days constant integer := 14;
  c_min_streak  constant integer := 3;
  c_outage_msgs constant text[]  := ARRAY['job startup timeout', 'server restarted'];
  v_found       jsonb;
BEGIN
  WITH runs AS (
    SELECT d.jobid, d.start_time, d.status, d.return_message
    FROM cron.job_run_details d
    WHERE d.start_time > now() - make_interval(days => c_window_days)
      AND d.status IN ('succeeded', 'failed')
      AND NOT (d.status = 'failed' AND d.return_message = ANY (c_outage_msgs))
  ), per_job AS (
    SELECT jobid, count(*) AS runs,
           max(start_time) FILTER (WHERE status = 'succeeded') AS last_ok
    FROM runs
    GROUP BY jobid
  ), streaks AS (
    -- Every counted run after the last success is a failure: that is the
    -- current streak.
    SELECT r.jobid, count(*) AS failures, min(r.start_time) AS failing_since,
           (array_agg(r.return_message ORDER BY r.start_time DESC))[1] AS last_error
    FROM runs r
    JOIN per_job p ON p.jobid = r.jobid
    WHERE r.status = 'failed' AND (p.last_ok IS NULL OR r.start_time > p.last_ok)
    GROUP BY r.jobid
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'job',      COALESCE(j.jobname, 'job ' || j.jobid),
           'jobid',    j.jobid,
           'schedule', j.schedule,
           'failures', s.failures,
           'since',    s.failing_since,
           'last_ok',  p.last_ok,
           'error',    left(COALESCE(s.last_error, ''), 400))
         ORDER BY COALESCE(j.jobname, 'job ' || j.jobid)), '[]'::jsonb)
    INTO v_found
  FROM streaks s
  JOIN per_job p ON p.jobid = s.jobid
  JOIN cron.job j ON j.jobid = s.jobid
  WHERE j.active
    AND s.failures >= LEAST(c_min_streak, p.runs);

  RETURN v_found;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_cron_sql_failures()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_found      jsonb;  -- failing right now, with details
  v_candidates jsonb;  -- their names: this check's sighting
  v_prev_cand  jsonb;  -- the previous check's sighting
  v_signature  jsonb;  -- names seen at both checks: the confirmed set, the de-dup key
  v_prev       jsonb;  -- the confirmed set of the last email
  v_status     text;
  v_detail     text;
  v_recovered  text;
  v_item       jsonb;
  v_rows       text := '';
  v_subject    text;
  v_html       text;
  v_sent       integer := 0;
BEGIN
  v_found := cron_sql_failures_now();
  SELECT COALESCE(jsonb_agg(e ->> 'job' ORDER BY e ->> 'job'), '[]'::jsonb)
    INTO v_candidates
  FROM jsonb_array_elements(v_found) AS e;

  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value END INTO v_prev_cand
  FROM platform_config WHERE key = 'cron_sql_health_candidates';
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value END INTO v_prev
  FROM platform_config WHERE key = 'cron_sql_health_signature';
  v_prev_cand := COALESCE(v_prev_cand, '[]'::jsonb);
  v_prev      := COALESCE(v_prev, '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(c.name ORDER BY c.name), '[]'::jsonb)
    INTO v_signature
  FROM jsonb_array_elements_text(v_candidates) AS c(name)
  WHERE v_prev_cand ? c.name;

  v_status := CASE WHEN jsonb_array_length(v_signature) > 0 THEN 'failing' ELSE 'ok' END;

  SELECT string_agg((e ->> 'job') || ': '
                    || CASE WHEN e ->> 'failures' = '1' THEN '1 falla' ELSE (e ->> 'failures') || ' fallas seguidas' END,
                    ' · ' ORDER BY e ->> 'job')
    INTO v_detail
  FROM jsonb_array_elements(v_found) AS e
  WHERE v_signature ? (e ->> 'job');
  v_detail := COALESCE(v_detail, 'todas las tareas programadas andan');
  IF jsonb_array_length(v_candidates) > jsonb_array_length(v_signature) THEN
    v_detail := v_detail || ' · en observación: '
      || (SELECT string_agg(c.name, ', ' ORDER BY c.name)
          FROM jsonb_array_elements_text(v_candidates) AS c(name)
          WHERE NOT (v_signature ? c.name));
  END IF;

  INSERT INTO platform_config (key, value) VALUES
    ('cron_sql_health_status',     to_jsonb(v_status)),
    ('cron_sql_health_signature',  v_signature),
    ('cron_sql_health_candidates', v_candidates),
    ('cron_sql_health_detail',     to_jsonb(v_detail)),
    ('cron_sql_health_at',         to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF v_signature IS DISTINCT FROM v_prev THEN
    SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_recovered
    FROM jsonb_array_elements_text(v_prev) AS r(name)
    WHERE NOT (v_signature ? r.name);

    IF v_status = 'failing' THEN
      FOR v_item IN
        SELECT e FROM jsonb_array_elements(v_found) AS e
        WHERE v_signature ? (e ->> 'job') ORDER BY e ->> 'job'
      LOOP
        v_rows := v_rows
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>'
          || replace(replace(replace(COALESCE(v_item ->> 'job', '?'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
          || '</b><br><span style="color:#666;font-size:12px">'
          || replace(replace(replace(COALESCE(v_item ->> 'schedule', ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
          || '</span></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">'
          || CASE WHEN v_item ->> 'failures' = '1' THEN '1 falla'
                  ELSE COALESCE(v_item ->> 'failures', '?') || ' fallas seguidas' END
          || '<br><span style="color:#666;font-size:12px">desde el '
          || COALESCE(to_char((v_item ->> 'since')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI'), '?')
          || '</span></td></tr>'
          || '<tr><td colspan="2" style="padding:4px 6px;color:#666;font-size:12px">'
          || COALESCE('Última vez que anduvo: '
                      || to_char((v_item ->> 'last_ok')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI'),
                      'No anduvo ni una vez en los últimos 14 días')
          || '</td></tr>'
          || '<tr><td colspan="2" style="padding:4px 6px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;color:#b91c1c">'
          -- Escape first, then turn the ERROR / HINT / CONTEXT lines into <br>.
          || replace(btrim(replace(replace(replace(COALESCE(v_item ->> 'error', ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\n'),
                     E'\n', '<br>')
          || '</td></tr>';
      END LOOP;

      v_subject := CASE WHEN jsonb_array_length(v_signature) = 1
                        THEN '[TriciGo] Tarea programada fallando: ' || (v_signature ->> 0)
                        ELSE '[TriciGo] ' || jsonb_array_length(v_signature) || ' tareas programadas fallando' END;
      v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111">'
        || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Tareas programadas de la base fallando</h2>'
        || '<p>Estas tareas automáticas de la base fallaron varias veces seguidas con un error propio, '
        || 'no por una caída de Supabase. Mientras sigan así, lo que hacen no se hace.</p>'
        || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
        || COALESCE('<p>Ya se recuperaron: '
                    || replace(replace(replace(v_recovered, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.</p>', '')
        || '<p><b>Qué revisar:</b> el error de cada tarea. Historial completo: '
        || '<code>SELECT start_time, status, return_message FROM cron.job_run_details '
        || 'WHERE jobid = &lt;jobid&gt; ORDER BY start_time DESC LIMIT 20;</code> '
        || 'Lo que falla ahora: <code>SELECT public.cron_sql_failures_now();</code></p>'
        || '<p style="color:#777;font-size:12px">Horas de Cuba. Llega un correo cuando cambia la lista de tareas que fallan: '
        || 'si una sigue fallando, no se repite. Aviso automático de tareas programadas. No responder.</p></body></html>';
    ELSE
      v_subject := '[TriciGo] Tareas programadas de la base recuperadas';
      v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111">'
        || '<h2 style="color:#16a34a;border-bottom:2px solid #16a34a;padding-bottom:8px">Tareas programadas recuperadas</h2>'
        || '<p>Todas las tareas programadas de la base vuelven a andar.</p>'
        || '<p style="color:#777;font-size:12px">Estaban fallando: '
        || replace(replace(replace(COALESCE(v_recovered, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.</p>'
        || '<p style="color:#777;font-size:12px">Aviso automático de tareas programadas. No responder.</p></body></html>';
    END IF;

    -- Shared ops mailer from 00577: every address in business_notification_email,
    -- and it refuses to send a blank body.
    v_sent := send_db_health_email(v_subject, v_html);
  END IF;

  RETURN jsonb_build_object('status', v_status, 'failing', v_signature, 'candidates', v_candidates,
                            'previous', v_prev, 'recovered', v_recovered, 'emails_sent', v_sent);
END;
$function$;

REVOKE ALL ON FUNCTION public.cron_sql_failures_now()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_cron_sql_failures() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_sql_failures_now()   TO service_role;
GRANT EXECUTE ON FUNCTION public.check_cron_sql_failures() TO service_role;

-- :45, free between prune-cron-run-details (:35), check-cron-http-failures
-- (:40) and check-poi-sync-freshness (:50). Pure SQL: no cron_http_post.
SELECT cron.unschedule('check-cron-sql-failures') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-cron-sql-failures');
SELECT cron.schedule('check-cron-sql-failures', '45 * * * *', 'SELECT public.check_cron_sql_failures();');

-- Seed the state with what is failing at apply time, as confirmed, so applying
-- this does not email about it (the same care 00577 took). The NOTICE lists
-- those jobs for whoever applies it; they email once they recover. A second
-- apply keeps the state the watchdog already has.
DO $$
DECLARE
  v_found jsonb := public.cron_sql_failures_now();
  v_names jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(e ->> 'job' ORDER BY e ->> 'job'), '[]'::jsonb) INTO v_names
  FROM jsonb_array_elements(v_found) AS e;

  INSERT INTO public.platform_config (key, value) VALUES
    ('cron_sql_health_status',     to_jsonb(CASE WHEN jsonb_array_length(v_names) > 0 THEN 'failing' ELSE 'ok' END)),
    ('cron_sql_health_signature',  v_names),
    ('cron_sql_health_candidates', v_names),
    ('cron_sql_health_detail',     to_jsonb('seeded by migration 00596'::text)),
    ('cron_sql_health_at',         to_jsonb(now()::text))
  ON CONFLICT (key) DO NOTHING;

  RAISE NOTICE '00596: failing at apply time (seeded, no email): %', v_names;
END $$;

-- Assert the check runs end to end instead of trusting the CREATE: plpgsql
-- does not type-check the body until it runs, and the email path only runs on
-- a change. Force one inside a subtransaction (a made-up job that "was
-- failing" and whatever fails now), check that every recipient got a
-- non-blank email, then undo everything: the state and the queued emails
-- (net.http_post only queues, and the queue is transactional).
DO $$
DECLARE
  v_expected integer;
  v_before   bigint;
  v_result   jsonb;
  v_queued   integer;
  v_blank    integer;
BEGIN
  SELECT count(*) INTO v_expected
  FROM public.platform_config pc,
       unnest(string_to_array(pc.value #>> '{}', ',')) AS t(x)
  WHERE pc.key = 'business_notification_email' AND position('@' IN x) > 0;

  BEGIN
    UPDATE public.platform_config SET value = '["00596-self-test"]'::jsonb WHERE key = 'cron_sql_health_signature';
    UPDATE public.platform_config
       SET value = (SELECT COALESCE(jsonb_agg(e ->> 'job'), '[]'::jsonb)
                    FROM jsonb_array_elements(public.cron_sql_failures_now()) AS e)
     WHERE key = 'cron_sql_health_candidates';

    SELECT COALESCE(max(q.id), 0) INTO v_before FROM net.http_request_queue q;
    v_result := public.check_cron_sql_failures();

    -- pg_net stores the request body as bytea.
    SELECT count(*),
           count(*) FILTER (WHERE btrim(COALESCE(convert_from(q.body, 'UTF8')::jsonb ->> 'template', '')) = '')
      INTO v_queued, v_blank
    FROM net.http_request_queue q
    WHERE q.id > v_before
      AND q.url LIKE '%/functions/v1/send-email';
    RAISE EXCEPTION '00596 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00596 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF (v_result ->> 'emails_sent')::integer IS DISTINCT FROM v_expected
     OR v_queued IS DISTINCT FROM v_expected OR v_blank <> 0 THEN
    RAISE EXCEPTION '00596: the check queued % emails (% blank) for % recipients: %',
      v_queued, v_blank, v_expected, v_result;
  END IF;
  RAISE NOTICE '00596: verified, a change emails all % recipients (%)', v_expected, v_result ->> 'status';
END $$;
