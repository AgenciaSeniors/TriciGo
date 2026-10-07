-- Scaffold for the 00636 rehearsal: the LIVE production shape of public.rate_limits
-- and its two functions, transcribed from information_schema, pg_indexes, pg_class
-- and pg_get_functiondef on 2026-10-07 (00631 applied; 00632-00635 do not touch these objects).
--
-- Ownership mirrors prod: a NON-superuser role (prod: postgres) owns the table and
-- the functions, and run.sh applies the migration as that role.
--
-- pg_cron is stubbed with cron.job column for column and schedule/unschedule with
-- pg_cron's upsert-by-name behaviour (same stub as supabase/tests/00596).
--
-- The function bodies are byte-identical to prod; run.sh S0 compares md5(prosrc)
-- with the values read from prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

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
GRANT USAGE ON SCHEMA cron TO tricigo_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON cron.job TO tricigo_owner;
GRANT USAGE ON SEQUENCE cron.job_jobid_seq TO tricigo_owner;
-- Two of the jobs prod already has, so a test can tell "ours" from "any".
INSERT INTO cron.job (jobname, schedule, command, username) VALUES
  ('prune-audit-log',      '25 * * * *', 'SELECT public.prune_audit_log();', 'tricigo_owner'),
  ('check-cron-sql-failures', '45 * * * *', 'SELECT public.check_cron_sql_failures();', 'tricigo_owner');

SET ROLE tricigo_owner;

-- LIVE public.rate_limits (00105): columns, PK, index, RLS on with no policy, not forced
CREATE TABLE public.rate_limits (
  key text NOT NULL,
  window_start timestamp with time zone NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_rate_limits_window ON public.rate_limits USING btree (window_start);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.rate_limits TO anon, authenticated, service_role;

-- LIVE public.check_rate_limit (00105 + search_path from 00348)
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limits (key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_max_requests,
    v_count,
    v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$function$;

-- LIVE public.cleanup_rate_limits (00105 + search_path from 00348). No cron job calls it.
CREATE OR REPLACE FUNCTION public.cleanup_rate_limits()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours';
$function$;

-- LIVE ACLs: {postgres=X/postgres,service_role=X/postgres} on both
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_rate_limits() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits() TO service_role;

RESET ROLE;
