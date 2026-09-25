-- Scaffold for the 00597 rehearsal (local Postgres 16, no Supabase stack needed).
-- It rebuilds the LIVE production shapes that 00596's SQL-cron watchdog reads
-- and writes, transcribed on 2026-09-25 from information_schema, pg_policies,
-- pg_roles and pg_get_functiondef (prod runs Postgres 17.6, pg_cron 1.6.4 in
-- libpq mode, pg_net 0.19.5):
--   * cron.job / cron.job_run_details: the pg_cron columns, RLS on with the
--     `username = CURRENT_USER` policy, owned by the superuser (supabase_admin
--     in prod, pgtest here). The 00596 job is scheduled like in prod.
--   * role postgres: NOT a superuser, BYPASSRLS. It applies migrations and owns
--     every watchdog in prod, so run.sh applies the migration as this role.
--   * byte for byte the bodies running in prod (md5(prosrc)):
--       cron_http_post            15d9ded451c60f92a0fd0a3c4e1ee0ab
--       check_cron_http_failures  6b98f714dda196b1cbec8bb8ca5877b5
--       cron_sql_failures_now     f5d29cd85b5f8bb54e683fc18a98fc32 (00596)
--       check_cron_sql_failures   fcfb06087336eaacbcc1d3acd53cefcf (00596)
--       send_db_health_email      4b9ed06fabc6d67a8f4666945fafd0a9 (00577)
--   * net.http_post: a stub with pg_net's signature that records the request in
--     net.http_request_queue instead of sending it. The body is bytea, as in
--     pg_net, so the migration's self-test reads it the way it does in prod.
--   * public.get_service_role_key(): a stub. Prod reads vault.
--   * platform_config holds the state 00596 seeded in prod on 2026-09-25:
--     cleanup_auth_revocations reported (it had not run clean since July).
-- Not rebuilt: platform_config's audit trigger (tg_platform_config_audit into
-- admin_actions). The watchdogs write through it every hour in prod, and the
-- migration's self-test goes through the real one when it is applied.
-- The t.* objects at the end are test helpers, not production shapes.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT USAGE, CREATE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ── pg_cron ──────────────────────────────────────────────────────────────────
CREATE SCHEMA cron;
CREATE SEQUENCE cron.jobid_seq;
CREATE SEQUENCE cron.runid_seq;

CREATE TABLE cron.job (
  jobid    bigint  NOT NULL DEFAULT nextval('cron.jobid_seq'),
  schedule text    NOT NULL,
  command  text    NOT NULL,
  nodename text    NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT inet_server_port(),
  database text    NOT NULL DEFAULT current_database(),
  username text    NOT NULL DEFAULT CURRENT_USER,
  active   boolean NOT NULL DEFAULT true,
  jobname  text
);
CREATE UNIQUE INDEX job_pkey ON cron.job (jobid);
CREATE UNIQUE INDEX jobname_username_uniq ON cron.job (jobname, username);

CREATE TABLE cron.job_run_details (
  jobid          bigint,
  runid          bigint NOT NULL DEFAULT nextval('cron.runid_seq'),
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);
CREATE UNIQUE INDEX job_run_details_pkey ON cron.job_run_details (runid);

ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY cron_job_policy ON cron.job USING (username = CURRENT_USER);
CREATE POLICY cron_job_run_details_policy ON cron.job_run_details USING (username = CURRENT_USER);
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL ON cron.job, cron.job_run_details TO postgres;
GRANT USAGE, SELECT ON SEQUENCE cron.jobid_seq, cron.runid_seq TO postgres;

-- Stubs with pg_cron's named signatures. SECURITY INVOKER on purpose: the real
-- C functions record the calling user, which is what CURRENT_USER is here.
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE v_id bigint;
BEGIN
  UPDATE cron.job SET schedule = $2, command = $3
   WHERE jobname = $1 AND username = CURRENT_USER
  RETURNING jobid INTO v_id;
  IF v_id IS NULL THEN
    INSERT INTO cron.job (schedule, command, jobname) VALUES ($2, $3, $1) RETURNING jobid INTO v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = $1 AND username = CURRENT_USER;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job ''%''', $1;
  END IF;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION cron.schedule(text, text, text), cron.unschedule(text) TO postgres;

-- ── pg_net ───────────────────────────────────────────────────────────────────
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (
  id                   bigserial PRIMARY KEY,
  method               text    NOT NULL,
  url                  text    NOT NULL,
  headers              jsonb,
  body                 bytea,
  timeout_milliseconds integer NOT NULL
);
CREATE TABLE net._http_response (
  id           bigint,
  status_code  integer,
  content_type text,
  headers      jsonb,
  content      text,
  timed_out    boolean,
  error_msg    text,
  created      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION net.http_post(
  url                  text,
  body                 jsonb   DEFAULT '{}'::jsonb,
  params               jsonb   DEFAULT '{}'::jsonb,
  headers              jsonb   DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', $1, $4, convert_to($2::text, 'UTF8'), $5)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT USAGE ON SCHEMA net TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA net TO postgres;

-- ── public ───────────────────────────────────────────────────────────────────
CREATE TABLE public.platform_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_config OWNER TO postgres;
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

-- Prod's value is a jsonb string with five addresses; three valid ones and a
-- malformed entry here, with the stray spaces of a hand-edited CSV.
INSERT INTO public.platform_config (key, value)
VALUES ('business_notification_email',
        to_jsonb('ops@example.test, dev@example.test,not-an-email , owner@example.test'::text));

CREATE TABLE public.cron_http_calls (
  request_id bigint      PRIMARY KEY,
  jobname    text        NOT NULL,
  url        text        NOT NULL,
  called_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cron_http_calls_called_at_idx ON public.cron_http_calls (called_at DESC);
ALTER TABLE public.cron_http_calls OWNER TO postgres;
ALTER TABLE public.cron_http_calls ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.cron_http_expectations (
  jobname     text  PRIMARY KEY,
  ok_statuses int[] NOT NULL,
  note        text
);
ALTER TABLE public.cron_http_expectations OWNER TO postgres;
INSERT INTO public.cron_http_expectations (jobname, ok_statuses, note) VALUES
  ('keepwarm-netopia-create-intent', ARRAY[200,401], '401 is by design'),
  ('keepwarm-netopia-mint',          ARRAY[200,401], '401 is by design');

CREATE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('test.service_role_key', true), 'test-service-role-key')
$$;
ALTER FUNCTION public.get_service_role_key() OWNER TO postgres;

-- LIVE bodies below. Every one of them runs as SECURITY DEFINER owned by
-- postgres with ACL {postgres=X, service_role=X}, as in prod.
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
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

CREATE OR REPLACE FUNCTION public.check_cron_http_failures()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  c_window_min  constant integer := 90;
  c_grace_sec   constant integer := 120;
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
           (resp.status_code IS NULL) AS is_timeout,
           (resp.status_code IS NOT NULL
            AND NOT (resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204])))) AS is_hard_fail,
           (resp.status_code IS NOT NULL
            AND resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204]))) AS is_ok
    FROM public.cron_http_calls c
    JOIN net._http_response resp ON resp.id = c.request_id
    LEFT JOIN public.cron_http_expectations e ON e.jobname = c.jobname
    WHERE c.called_at >  now() - make_interval(mins => c_window_min)
      AND c.called_at <  now() - make_interval(secs => c_grace_sec)
  ),
  agg AS (
    SELECT jobname,
           count(*)                             AS total,
           count(*) FILTER (WHERE is_ok)        AS oks,
           count(*) FILTER (WHERE is_hard_fail) AS hard_fails,
           count(*) FILTER (WHERE is_timeout)   AS timeouts,
           string_agg(DISTINCT status_code::text, '/') FILTER (WHERE is_hard_fail) AS codes,
           max(left(COALESCE(content, error_msg, ''), 120)) FILTER (WHERE is_hard_fail OR is_timeout) AS sample
    FROM judged GROUP BY jobname
  )
  SELECT jobname,
         (hard_fails + CASE WHEN oks = 0 THEN timeouts ELSE 0 END) AS failures,
         timeouts,
         COALESCE(codes, 'timeout') AS codes,
         sample
  FROM agg
  WHERE hard_fails >= c_min_hard
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
          || 'Un timeout suelto entre respuestas OK NO alerta: pg_net deja de esperar pero la funcion sigue corriendo.</p>'
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

CREATE OR REPLACE FUNCTION public.send_db_health_email(p_subject text, p_html text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_sent        int := 0;
BEGIN
  SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN RETURN 0; END IF;

  -- Cinturón: un cuerpo nulo o vacío significa que el armado del HTML falló.
  -- Mejor no mandar nada y dejar rastro en los logs que mandar 5 correos en
  -- blanco que nadie sabe interpretar.
  IF p_html IS NULL OR btrim(p_html) = '' OR p_subject IS NULL THEN
    RAISE WARNING 'send_db_health_email: cuerpo vacío, no se envía (subject=%)', p_subject;
    RETURN 0;
  END IF;

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);

  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
  LOOP
    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', p_subject,
                                    -- HTML crudo por el legacy path de resolveTemplate().
                                    'template', p_html, 'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cron_sql_failures_now()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

DO $$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY['public.cron_http_post(text, text, jsonb, jsonb, integer)', 'public.check_cron_http_failures()',
                               'public.send_db_health_email(text, text)', 'public.cron_sql_failures_now()', 'public.check_cron_sql_failures()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
END $$;

-- 00596's job, scheduled by postgres like in prod (jobid 57 there).
SET ROLE postgres;
SELECT cron.schedule('check-cron-sql-failures', '45 * * * *', 'SELECT public.check_cron_sql_failures();');
RESET ROLE;

-- ═════════════════════════════════════════════════════════════════════════════
-- Test helpers (not production shapes)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA t;

-- One character per run. O succeeded · E SQL error · T SQL statement timeout ·
-- P COPY not supported · S job startup timeout · R server restarted ·
-- C connection failed · L connection lost · K job canceled ·
-- N failed with no message · X still running. The E and T texts are the ones
-- prod stored (cleanup_auth_revocations', and retry-dispatch-expired-rides'
-- during the 2026-09-21 outage); the other failures are pg_cron's own
-- messages, from its source (src/pg_cron.c).
CREATE FUNCTION t.status(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind WHEN 'O' THEN 'succeeded' WHEN 'X' THEN 'running' ELSE 'failed' END
$$;

CREATE FUNCTION t.msg(p_kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'O' THEN '1 row'
    WHEN 'E' THEN E'ERROR:  query returned more than one row\nHINT:  Make sure the query returns a single row, or use LIMIT 1.\nCONTEXT:  PL/pgSQL function cleanup_auth_revocations() line 5 at SQL statement\n'
    WHEN 'T' THEN E'ERROR:  canceling statement due to statement timeout\nCONTEXT:  PL/pgSQL function notify_offline_drivers_for_searching_rides() line 35 at FOR over SELECT rows\nSQL statement "SELECT notify_offline_drivers_for_searching_rides()"\nPL/pgSQL function retry_dispatch_expired_rides() line 28 at PERFORM\n'
    WHEN 'P' THEN 'COPY not supported'
    WHEN 'S' THEN 'job startup timeout'
    WHEN 'R' THEN 'server restarted'
    WHEN 'C' THEN 'connection failed'
    WHEN 'L' THEN 'connection lost'
    WHEN 'K' THEN 'job canceled'
  END
$$;

-- The watchdog state 00596 seeded in prod on 2026-09-25.
CREATE FUNCTION t.prod_state() RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.platform_config (key, value) VALUES
    ('cron_sql_health_status',     to_jsonb('failing'::text)),
    ('cron_sql_health_signature',  '["cleanup_auth_revocations"]'::jsonb),
    ('cron_sql_health_candidates', '["cleanup_auth_revocations"]'::jsonb),
    ('cron_sql_health_detail',     to_jsonb('seeded by migration 00596'::text)),
    ('cron_sql_health_at',         to_jsonb('2026-09-25 19:49:15.154897+00'::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
$$;

-- Empties everything the tests look at. Keeps the watchdog's own job.
CREATE FUNCTION t.reset() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job_run_details;
  DELETE FROM cron.job WHERE jobname IS DISTINCT FROM 'check-cron-sql-failures';
  DELETE FROM net.http_request_queue;
  DELETE FROM net._http_response;
  DELETE FROM public.cron_http_calls;
  DELETE FROM public.platform_config WHERE key LIKE 'cron\_sql\_health\_%' OR key LIKE 'cron\_http\_health\_%';
  INSERT INTO public.platform_config (key, value)
  VALUES ('business_notification_email',
          to_jsonb('ops@example.test, dev@example.test,not-an-email , owner@example.test'::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;

-- Creates the job if needed and adds one run per pattern character, oldest
-- first, p_step apart, the newest starting p_last_ago before now().
CREATE FUNCTION t.seed(p_name text, p_schedule text, p_pattern text, p_step interval, p_last_ago interval)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
  v_n  integer := length(p_pattern);
  v_i  integer;
  v_k  text;
  v_at timestamptz;
BEGIN
  SELECT j.jobid INTO v_id FROM cron.job j WHERE j.jobname = p_name AND j.username = 'postgres';
  IF v_id IS NULL THEN
    INSERT INTO cron.job (schedule, command, username, jobname)
    VALUES (p_schedule, 'SELECT public.' || p_name || '();', 'postgres', p_name)
    RETURNING jobid INTO v_id;
  END IF;
  FOR v_i IN 1 .. v_n LOOP
    v_k  := substr(p_pattern, v_i, 1);
    v_at := now() - p_last_ago - (v_n - v_i) * p_step;
    INSERT INTO cron.job_run_details (jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
    SELECT v_id, 4000 + v_i, j.database, j.username, j.command, t.status(v_k), t.msg(v_k), v_at,
           CASE WHEN v_k = 'X' THEN NULL ELSE v_at + interval '40 milliseconds' END
    FROM cron.job j WHERE j.jobid = v_id;
  END LOOP;
END $$;

-- What the watchdog queued, decoded the way the migration's self-test reads it.
CREATE VIEW t.sent AS
  SELECT q.id, q.url,
         q.headers ->> 'Authorization'                              AS auth_header,
         q.headers ->> 'apikey'                                     AS apikey,
         convert_from(q.body, 'UTF8')::jsonb ->> 'recipient_email' AS recipient,
         convert_from(q.body, 'UTF8')::jsonb ->> 'subject'         AS subject,
         convert_from(q.body, 'UTF8')::jsonb ->> 'template'        AS template,
         c.jobname                                                  AS tracked_as
  FROM net.http_request_queue q
  LEFT JOIN public.cron_http_calls c ON c.request_id = q.id;

-- Real run sequences from prod's cron.job_run_details during the September
-- outages: "<kind><seconds after t0>" per run, exactly as pg_cron recorded
-- them (runs are missing where the scheduler could not even queue one). Every
-- T is a SQL error the outage caused; none is a bug.
CREATE TABLE t.outage (tag text PRIMARY KEY, jobname text NOT NULL, schedule text NOT NULL,
                       step_s integer NOT NULL, t0 timestamptz NOT NULL, runs text NOT NULL);
INSERT INTO t.outage VALUES
('2026-09-18', 'cleanup_orphan_searching_rides', '* * * * *', 60, '2026-09-18 06:30:00+00', 'O0 O60 O120 O180 O240 O300 S360 S420 S480 O549 O614 S660 S720 S780 S840 S900 S963 S1020 S1080 O1145 O1207 S1298 S1320 S1380 S1610 O1624 S1744 S1754 S1818 S1863 S1873 S1883 S1920 S1980 S2040 S2100 S2254 T2271 S2418 O2433 O2486 O2492 S2520 S2743 S2753 S2763 S2778 S2820 S2880 S3462 S4147 S4158 S4200 S4260 S4320 S4808 S4867 S4920 S4980 S5476 S5486 S5520 S5580 S5699 O5721 S5760 S5900 S5920 O5948 S6000 S6064 S6120 O6184 S6240 S6300 O6363 O6507 S6544 O6562 S6600 S6660 S6720 S6780 S6925 S6953 S6963 S7020 S7080 S7140 S7200 S7297 S7320 S7380 S7508 S7518 S7560 S7620 S7680 S7740 S7800 O7871 O7921 S7980 S8040 S8100 S8160 S8220 O8300 S8390 S8490 S8536 S8550 O8615 S8703 S8715 S8807 O8826 S9118 S9130 T9146 S10101 O10147 S10706 S10726 T10746 O10895 O10917 O10919 O10919 O10921 O10921 O10921 O10921 O10922 O10922 O10922 O10922 O10922 O10923 O10923 O10923 O10924 O10988 O11080 S11100 T11167 S11411 O11434 S11558 O11574 O11652 O11671 S11749 S11759 S11769 T11795 O11951 S12379 S12410 S12434 S12444 S12552 S12564 S12583 S12600 S12660 S12933 S12983 S13002 S13013 S13024 S13038 S13080 S13140 S13938 S15206 S15218 S15229 S15239 T15255 S15976 S15986 O16023 S16243 S16280 S16313 S16340 S16350 S16380 S16440 S16500 S16584 S16620 S16680 S16740 S16800 S16860 S17007 S17018 S17040 S17100 S17160 S17220 S17332 S17346 S17400 O17486 O17603 O17616 S17640 S17700 S17792 O17828 O17957 O17993 O18062 S18116 O18139 O18213 S18240 S18300 S18360 S18420 S18480 S18540 S18600 S18827 S18838 S18848 O18922 S18984 S18994 O19021 S19122 T19141 S19386 S19401 S19412 S19422 S19440 S19500 S19560 S19620 S19680 T19748 S19971 O20012 O20015 O20016 O20040 O20100 O20160 O20220 O20280 O20340 O20400 O20460 O20520 O20580 O20640'),
('2026-09-20', 'retry-dispatch-expired-rides', '*/1 * * * *', 60, '2026-09-20 09:40:00+00', 'O0 O60 O120 O180 O240 O304 S360 O425 S480 S540 S600 S840 S852 S862 S875 S900 S1072 S1091 T1110 S1264 S1277 S1287 S1320 S1380 S1440 S1500 S1560 S1620 S1812 S1824 S1952 S1962 S1972 S1982 S2324 S2521 S2531 S2541 S2738 S2957 T2977 S3765 T3784 S4160 S4170 S4184 S4194 S4204 S4219 O4233 O4347 O4369 S4379 O4392 S4418 T4460 S4947 S4957 S4987 T5002 S5810 S5863 S5873 O5895 S6280 S6338 S6348 S6358 S6385 S6395 S6407 T6425 S6882'),
('2026-09-20-keepwarm', 'keepwarm-netopia-mint', '*/2 * * * *', 120, '2026-09-20 10:20:00+00', 'S121 S131 S141 S338 S557 T571 S1365 T1384 S1760 S1770 S1784 S1794'),
('2026-09-21', 'retry-dispatch-expired-rides', '*/1 * * * *', 60, '2026-09-21 09:15:00+00', 'O0 O60 O120 O180 O240 O300 O360 O420 O480 S540 S600 S660 S720 S841 S853 S900 S1060 S1073 T1094 S1267 S1277 S1317 S1330 S1380 S1440 S1533 S1560 S1620 S1783 S1793 S1809 S1860 S1920 S2262 S2278 T2298 S2539 T2560 S3086 S3096 S3106 S3260 S3277 S3287 S3670 S3707 S3717 S3810 S3830 S3842 S3852 S3862 S3895 S4429 S4439 S4451 S4461 S4500 S4560 T4627 S4817 S4864 S4874 S4891 S4920 S4980 S5088 S5105 S5160 S5220 S5280 S5340 S5448 S5474 S5520 S5621 S5643 S5700 S5760 S5820 S5880 S5973 S6000 S6060 S6120 S6180 S6240 S6300 S6360 S6420 S6561 S6883 S6894 S6905 T6924 S7168 S7180 S7191 S7205 O7221 S7327 O7339 O7414 O7419 O7420 S7420 O7440 S7500 S7626 S7642 S7680 S7740 S7854 S7874 S7920 S8499 S8520 S8582 S8640 S8814 S8826 S9488 S9523 S9609 S9636 S9660 S9720 S10208 S10219 S10260 S10320 S10380 S10440 O11820 O11880 O11940');

-- Replays one outage window through the real watchdog, check by check, the
-- way prod ran it: at every :45 from the window's start to an hour after its
-- end, the job's runs up to that moment are loaded as if that moment were
-- now(), then check_cron_sql_failures() runs with the state the previous check
-- left. The hour before the window and the hour after it are clean runs at the
-- job's cadence, as they were in prod: 00596's rule depends on how many runs a
-- job has in the window, so the replay must not make the outage look like the
-- job's whole history.
-- p_swap_s: log this message instead of 'job startup timeout', to ask how the
-- same outage would have been judged if pg_cron had recorded it that way.
CREATE FUNCTION t.replay_checks(p_tag text, p_swap_s text DEFAULT NULL)
RETURNS TABLE (r_check_at timestamptz, r_status text, r_candidates jsonb, r_failing jsonb, r_emails integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_o     t.outage%ROWTYPE;
  v_id    bigint;
  v_end   timestamptz;
  v_check timestamptz;
  v_runs  text[];
  v_res   jsonb;
  v_tok   text;
  v_i     integer;
  v_k     text;
  v_at    timestamptz;
BEGIN
  SELECT * INTO v_o FROM t.outage WHERE tag = p_tag;
  PERFORM t.seed(v_o.jobname, v_o.schedule, '', interval '1 minute', interval '0');
  SELECT j.jobid INTO v_id FROM cron.job j WHERE j.jobname = v_o.jobname AND j.username = 'postgres';

  -- The whole sequence in real time: an hour of clean runs, the window, an hour of clean runs.
  SELECT v_o.t0 + max(substr(x, 2)::integer) * interval '1 second' INTO v_end
  FROM unnest(string_to_array(v_o.runs, ' ')) AS w(x);
  v_runs := ARRAY(SELECT 'O' || (-3600 + g * v_o.step_s) FROM generate_series(0, 3600 / v_o.step_s - 1) AS g)
         || string_to_array(v_o.runs, ' ')
         || ARRAY(SELECT 'O' || (extract(epoch FROM v_end - v_o.t0)::integer + g * v_o.step_s)
                  FROM generate_series(1, 3600 / v_o.step_s) AS g);

  v_check := date_trunc('hour', v_o.t0) + interval '45 minutes';
  IF v_check < v_o.t0 THEN v_check := v_check + interval '1 hour'; END IF;
  WHILE v_check <= v_end + interval '1 hour' LOOP
    DELETE FROM cron.job_run_details WHERE jobid = v_id;
    v_i := 0;
    FOREACH v_tok IN ARRAY v_runs LOOP
      v_i  := v_i + 1;
      v_at := v_o.t0 + substr(v_tok, 2)::integer * interval '1 second' + v_i * interval '1 microsecond';
      EXIT WHEN v_at > v_check;
      v_k := left(v_tok, 1);
      INSERT INTO cron.job_run_details (jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
      SELECT v_id, 5000 + v_i, j.database, j.username, j.command, t.status(v_k),
             CASE WHEN v_k = 'S' AND p_swap_s IS NOT NULL THEN p_swap_s ELSE t.msg(v_k) END,
             now() - (v_check - v_at), now() - (v_check - v_at) + interval '40 milliseconds'
      FROM cron.job j WHERE j.jobid = v_id;
    END LOOP;
    v_res        := public.check_cron_sql_failures();
    r_check_at   := v_check;
    r_status     := v_res ->> 'status';
    r_candidates := v_res -> 'candidates';
    r_failing    := v_res -> 'failing';
    r_emails     := (v_res ->> 'emails_sent')::integer;
    RETURN NEXT;
    v_check := v_check + interval '1 hour';
  END LOOP;
END $$;

-- A copy of the live 00596 check (same body as check_cron_sql_failures above)
-- under another name, so that a test can compare what the patched check
-- sends with what 00596 sent, in the same transaction.
CREATE FUNCTION t.check_cron_sql_failures_00596()
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

-- Production's shape on 2026-09-25: cleanup_auth_revocations failed its last
-- 14 nightly runs, a busy per-minute job is healthy, and 00596's state has
-- cleanup_auth_revocations reported.
SELECT t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), interval '1 day', interval '15 hours');
SELECT t.seed('expire-ride-offers', '*/1 * * * *', repeat('O', 180), interval '1 minute', interval '1 minute');
SELECT t.prod_state();
