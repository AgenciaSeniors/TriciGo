-- Supabase pieces and stubs for the 00668 rehearsal. Loaded first, as the superuser pgtest; then
-- prod-objects.sql (generated from prod by capture-prod.sql) and seed.sql.
-- Every object belongs to a NON-superuser role named postgres, as in prod, and postgres is a
-- member of anon, authenticated and service_role, as in prod (00668's check runs SET ROLE anon).
-- Stubs: cron_http_post (records each call in test_http_calls; fails when test.http_fail = '1'),
-- get_service_role_key (empty when test.no_key = '1'), log_rpc_attempt (records in test_rpc_log),
-- check_rate_limit (counts in test_rate_hits). PostGIS is not installed: locations are text, and
-- geometry/geography are text domains with st_x/st_y returning 0.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA storage AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;
-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

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
CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$function$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO PUBLIC;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  phone text,
  phone_confirmed_at timestamptz,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz
);
CREATE TABLE auth.identities (
  user_id       uuid NOT NULL,
  provider      text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE storage.objects (
  id         uuid DEFAULT gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
-- Prod: the folders of a path ('a/b/c.pdf' -> {a,b}).
CREATE OR REPLACE FUNCTION storage.foldername(name text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1:array_length(_parts, 1) - 1];
END
$function$;
GRANT EXECUTE ON FUNCTION storage.foldername(text) TO PUBLIC;

CREATE DOMAIN public.geometry AS text;
CREATE DOMAIN public.geography AS text;
CREATE FUNCTION public.st_x(public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 0::double precision $$;
CREATE FUNCTION public.st_y(public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT 0::double precision $$;

CREATE TABLE public.test_http_calls (
  id bigserial PRIMARY KEY,
  jobname text,
  url text,
  body jsonb,
  at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE public.test_rpc_log (rpc_name text, caller uuid, target uuid, outcome text, metadata jsonb);
CREATE TABLE public.test_rate_hits (key text, at timestamptz DEFAULT clock_timestamp());

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
  INSERT INTO public.test_http_calls (jobname, url, body) VALUES (p_jobname, url, body) RETURNING id INTO v_id;
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
CREATE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text,
                                       p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
BEGIN
  INSERT INTO public.test_rpc_log VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$function$;
CREATE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.test_rate_hits h
  WHERE h.key = p_key AND h.at > clock_timestamp() - make_interval(secs => p_window_seconds);
  IF v_n >= p_max_requests THEN
    RETURN QUERY SELECT false, v_n, clock_timestamp();
    RETURN;
  END IF;
  INSERT INTO public.test_rate_hits (key) VALUES (p_key);
  RETURN QUERY SELECT true, v_n + 1, clock_timestamp();
END
$function$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
RESET ROLE;
