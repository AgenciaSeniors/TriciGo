-- Scaffold for the 00656 rehearsal (team daily digest).
-- Prod's tables as of 2026-10-11, reduced to the columns 00656 reads. Every object belongs to a
-- NON-superuser role named postgres, as in prod. Prod has PostGIS in public; here it lives in the
-- extensions schema so that every function of public belongs to postgres (run.sh S1). 00656 calls no
-- PostGIS function directly (only _poi_admin_area, whose search_path covers both schemas).
-- Enum columns use prod's enum types and labels (2026-10-11), so a literal that is not a label fails here too.
-- Live bodies, byte for byte from prod (pg_get_functiondef, 2026-10-11): _poi_admin_area,
-- mailable_user_emails, get_platform_config_text; run.sh S0 compares their md5 with prod.
-- Stubs: pg_cron, cron_http_post (records each call), get_service_role_key (empty when the
-- session setting test.no_key = '1').
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;

CREATE SCHEMA extensions;
CREATE EXTENSION postgis SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

-- pg_cron stub (same as supabase/tests/00649): schedule upserts by name and keeps the active flag.
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
CREATE TABLE auth.identities (
  user_id       uuid NOT NULL,
  provider      text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.incident_status AS ENUM ('open', 'investigating', 'resolved', 'dismissed');
CREATE TYPE public.incident_type AS ENUM ('sos', 'safety_concern', 'payment_dispute', 'vehicle_issue', 'driver_behavior',
  'passenger_behavior', 'review_abuse');
CREATE TYPE public.pricing_snapshot_type AS ENUM ('estimate', 'final');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

CREATE TABLE public.users (
  id                uuid PRIMARY KEY,
  email             text,
  full_name         text NOT NULL DEFAULT '',
  role              public.user_role NOT NULL DEFAULT 'customer',
  is_active         boolean NOT NULL DEFAULT true,
  is_test           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  signup_code       text,
  email_verified_at timestamptz
);
CREATE TABLE public.driver_profiles (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.users (id),
  status      public.driver_status NOT NULL,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rides (
  id              uuid PRIMARY KEY,
  customer_id     uuid NOT NULL,
  driver_id       uuid,
  status          public.ride_status NOT NULL,
  canceled_by     uuid,
  service_type    text NOT NULL,
  pickup_location extensions.geography(Point, 4326),
  final_fare_cup  integer,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz
);
CREATE TABLE public.ride_offers (id bigserial PRIMARY KEY, ride_id uuid NOT NULL, status text NOT NULL DEFAULT 'expired');
CREATE TABLE public.driver_heartbeat_log (driver_profile_id uuid NOT NULL, beat_at timestamptz NOT NULL, is_online boolean);
CREATE TABLE public.ride_pricing_snapshots (ride_id uuid NOT NULL, snapshot_type public.pricing_snapshot_type NOT NULL, commission_amount integer NOT NULL DEFAULT 0);
CREATE TABLE public.payment_intents (id bigserial PRIMARY KEY, user_id uuid NOT NULL, amount_cup integer NOT NULL, status text NOT NULL, paid_at timestamptz);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, name_es text NOT NULL);
CREATE TABLE public.cuba_admin_areas (id bigserial PRIMARY KEY, admin_level integer NOT NULL, name_es text, geom extensions.geometry);
CREATE TABLE public.incident_reports (id bigserial PRIMARY KEY, type public.incident_type NOT NULL, status public.incident_status NOT NULL);
CREATE TABLE public.ride_disputes (id bigserial PRIMARY KEY, resolved_at timestamptz, sla_resolution_deadline timestamptz);
CREATE TABLE public.acquisition_codes (code text PRIMARY KEY, label text NOT NULL);
CREATE TABLE public.referrals (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE TABLE public.campaigns (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  status     text NOT NULL,
  sent_at    timestamptz,
  push_sent  integer NOT NULL DEFAULT 0,
  email_sent integer NOT NULL DEFAULT 0
);
CREATE TABLE public.promotions (id uuid PRIMARY KEY, code text NOT NULL);
CREATE TABLE public.promotion_uses (id bigserial PRIMARY KEY, promotion_id uuid NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- LIVE bodies (prod, 2026-10-11). _poi_admin_area's argument is an unqualified geography: prod finds it
-- in public, this scaffold in extensions (see the header).
SET search_path = "$user", public, extensions;
CREATE OR REPLACE FUNCTION public._poi_admin_area(p_point geography, OUT municipality text, OUT province text)
 RETURNS record
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 6 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1),
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 4 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1);
$function$;

CREATE OR REPLACE FUNCTION public.mailable_user_emails(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT u.id, btrim(u.email)
  FROM public.users u
  WHERE u.id = ANY (p_user_ids)
    AND btrim(coalesce(u.email, '')) <> ''
    AND (
      u.email_verified_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM auth.identities i
        WHERE i.user_id = u.id
          AND i.provider IN ('google', 'apple')
          AND lower(i.identity_data->>'email_verified') = 'true'
          AND lower(btrim(i.identity_data->>'email')) = lower(btrim(u.email))
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.get_platform_config_text(p_key text, p_fallback text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN COALESCE(v_raw #>> '{}', p_fallback);
END;
$function$;

-- Stubs: the vault key and the cron HTTP helper. cron_http_post records each call.
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT CASE current_setting('test.no_key', true) WHEN '1' THEN ''::text ELSE 'test-service-key'::text END
$$;
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

RESET search_path;
RESET ROLE;

-- Test helpers (not production shapes).
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
-- t.outcome(sql) -> 'ok: <first column of the first row>' or 'raised <sqlstate>: <message> [<detail>]'
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $o$
DECLARE
  v text;
  v_detail text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'ok: ' || coalesce(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN 'raised ' || SQLSTATE || ': ' || SQLERRM || CASE WHEN coalesce(v_detail, '') <> '' THEN ' [' || v_detail || ']' ELSE '' END;
END $o$;
GRANT EXECUTE ON FUNCTION t.outcome(text) TO PUBLIC;
-- t.eq(actual, expected) -> 'ok' or the actual value
CREATE FUNCTION t.eq(a jsonb, b jsonb) RETURNS text LANGUAGE sql AS $e$
  SELECT CASE WHEN a = b THEN 'ok' ELSE coalesce(a::text, '<null>') END
$e$;
