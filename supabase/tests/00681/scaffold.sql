-- Scaffold for the 00679 rehearsal (one owner per assisted ride). Loaded as the superuser before
-- tables.sql and live-bodies.sql.
-- Every object belongs to a NON-superuser role named postgres, as in prod, and postgres is a member
-- of anon, authenticated and service_role. Tables get the grants Supabase gave until 2026-10-30, so
-- the migration's own REVOKEs are what closes them. Stubs record what the functions would send.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO CURRENT_USER;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA cron AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;
-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- pg_cron stub (as in supabase/tests/00628): the job table and schedule(), which updates a job of the
-- same name like pg_cron does.
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  jobname text UNIQUE
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$f$;

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

-- Stubs. cron_http_post records each push (its label and body) in test_pushes, which the cases
-- read; get_service_role_key returns a key unless test.no_key is set.
CREATE TABLE public.test_pushes (
  id bigserial PRIMARY KEY,
  label text,
  body jsonb,
  at timestamptz DEFAULT clock_timestamp()
);

CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
                                      body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF current_setting('test.http_fail', true) = '1' THEN
    RAISE EXCEPTION 'test: the HTTP call failed';
  END IF;
  INSERT INTO public.test_pushes (label, body) VALUES (p_jobname, body) RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

CREATE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE WHEN current_setting('test.no_key', true) = '1' THEN '' ELSE 'test-service-key' END
$function$;

-- Prod's grants on the two (2026-11-07): the owner and service_role only.
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer), public.get_service_role_key()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer), public.get_service_role_key()
  TO service_role;
