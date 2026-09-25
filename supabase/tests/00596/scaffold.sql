-- Scaffold for the 00596 rehearsal: the LIVE production shapes the SQL cron
-- watchdog reads and writes, transcribed on 2026-09-25 from information_schema
-- and pg_get_functiondef.
--   cron.job / cron.job_run_details   column for column as pg_cron has them
--   public.platform_config            key text PK, value jsonb, updated_at
--   public.send_db_health_email()     byte for byte the live body (00577,
--                                      md5(prosrc) 4b9ed06fabc6d67a8f4666945fafd0a9)
-- Stand-ins: net.http_post() records each request in net.http_request_queue
-- instead of sending it (in prod that queue is transactional too), and
-- cron.schedule/unschedule keep pg_cron's upsert-by-name behaviour.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- pg_cron
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid    bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command  text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active   boolean NOT NULL DEFAULT true,
  jobname  text,
  CONSTRAINT jobname_username_uniq UNIQUE (jobname, username)
);
CREATE TABLE cron.job_run_details (
  jobid          bigint,
  runid          bigserial PRIMARY KEY,
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname, username) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT count(*) > 0 FROM d
$$;

-- pg_net: same named parameters as the real net.http_post.
CREATE SCHEMA net;
-- Column for column as pg_net has it: the body is stored as bytea.
CREATE TABLE net.http_request_queue (
  id                   bigserial PRIMARY KEY,
  method               text NOT NULL,
  url                  text NOT NULL,
  headers              jsonb,
  body                 bytea,
  timeout_milliseconds integer NOT NULL
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) RETURNING id
$$;

-- LIVE platform_config.
CREATE TABLE public.platform_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
-- Five recipients, as in prod (addresses made up).
INSERT INTO public.platform_config (key, value) VALUES
  ('business_notification_email', to_jsonb('ops1@example.com, ops2@example.com,ops3@example.com, ops4@example.com, ops5@example.com'::text));

CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'test-service-role-key'::text $$;

-- LIVE (00577).
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
REVOKE ALL ON FUNCTION public.send_db_health_email(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_db_health_email(text, text) TO service_role;

-- A few jobs like prod's. Their run history is seeded per test.
SELECT cron.schedule('retry-dispatch-expired-rides', '*/1 * * * *', 'SELECT retry_dispatch_expired_rides();');
SELECT cron.schedule('cleanup_auth_revocations',     '0 3 * * *',   'SELECT public.cleanup_auth_revocations();');
SELECT cron.schedule('anonymize-old-rides-yearly',   '0 4 * * 0',   'SELECT public.anonymize_old_rides();');
