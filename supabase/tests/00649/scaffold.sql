-- Scaffold for the 00649 rehearsal (scheduled campaigns).
-- Prod's tables as of 2026-10-09, reduced to the columns 00649 reads, and prod's policies on
-- public.campaigns. The role helpers are the live bodies (current_user_role, is_admin from
-- supabase/tests/00642/live-bodies.sql; is_marketing from migration 00642).
-- Every object belongs to a NON-superuser role named postgres, as in prod, so RLS applies to
-- anon, authenticated and service_role and not to the owner.
-- Simplified on purpose: public.users has no RLS (prod lets each user read its own row, which is
-- all the campaigns admin policy needs); pg_cron, cron_http_post and get_service_role_key are stubs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

-- pg_cron stub: cron.job column for column, schedule/unschedule upsert by name (as 00636).
-- Like pg_cron 1.6, schedule updates an existing job's schedule and command but not its active flag;
-- alter_job changes only what it is given.
CREATE SCHEMA cron AUTHORIZATION postgres;
SET ROLE postgres;
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
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  UPDATE cron.job j
     SET schedule = COALESCE(alter_job.schedule, j.schedule),
         command  = COALESCE(alter_job.command, j.command),
         database = COALESCE(alter_job.database, j.database),
         username = COALESCE(alter_job.username, j.username),
         active   = COALESCE(alter_job.active, j.active)
   WHERE j.jobid = alter_job.job_id
$$;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');

CREATE TABLE public.cities (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  full_name text NOT NULL DEFAULT '',
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  city_id uuid REFERENCES public.cities(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  total_rides integer NOT NULL DEFAULT 0,
  total_rides_completed integer NOT NULL DEFAULT 0
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.promotions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL);

-- LIVE public.campaigns (00073 + 00478 + 00491), constraints as in prod.
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  segment_type text NOT NULL,
  segment_city_id uuid REFERENCES public.cities(id),
  message_title text NOT NULL,
  message_body text NOT NULL,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  sent_count integer DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  audience_role text NOT NULL DEFAULT 'customer',
  CONSTRAINT campaigns_audience_role_chk CHECK (audience_role = ANY (ARRAY['customer'::text, 'driver'::text]))
);

-- LIVE role helpers.
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_marketing()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$$;

-- Stubs: the vault key and the cron HTTP helper. cron_http_post records each call.
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 'test-service-key'::text $$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;

CREATE TABLE public.cron_http_post_calls (
  id bigserial PRIMARY KEY,
  jobname text, url text, headers jsonb, body jsonb, timeout_ms integer
);
CREATE OR REPLACE FUNCTION public.cron_http_post(
  p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 30000
) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO public.cron_http_post_calls (jobname, url, headers, body, timeout_ms)
  VALUES (p_jobname, url, headers, body, timeout_milliseconds) RETURNING id
$$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;

-- LIVE policies on public.campaigns.
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin full access on campaigns" ON public.campaigns
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
                 AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))
  WITH CHECK (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
                      AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY campaigns_insert_marketing ON public.campaigns FOR INSERT TO authenticated
  WITH CHECK ((SELECT is_marketing()) AND (created_by = (SELECT auth.uid())));
CREATE POLICY campaigns_select_marketing ON public.campaigns FOR SELECT TO authenticated
  USING ((SELECT is_marketing()));

RESET ROLE;
