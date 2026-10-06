-- Scaffold for the 00608 rehearsal: the LIVE production shapes of platform_config,
-- its pc_select policy and the functions 00608 touches, transcribed from
-- pg_get_functiondef, pg_policy and proacl on 2026-10-06 (00606 applied).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST sets it.
--
-- Ownership mirrors prod: a NON-superuser role (prod: postgres) owns the tables and
-- functions and run.sh applies the migration as that role. The function ACLs are
-- set to what prod shows, including the default EXECUTE for PUBLIC.
--
-- Not modelled: PostGIS. refresh_cuba_landmask is created with its live body (plpgsql
-- does not resolve ST_* until it runs) and the suite only checks who may call it.
-- run.sh S0 compares md5(prosrc) of every function with the values read from prod.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer'
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

-- LIVE public.platform_config (columns, PK, RLS on, not forced, SELECT policy)
CREATE TABLE public.platform_config (
  key text NOT NULL PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.platform_config TO anon, authenticated;
GRANT ALL ON public.platform_config TO service_role;

-- Tables the function bodies read
CREATE TABLE public.cancellation_penalties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.cuba_admin_areas (admin_level int, geom text);
CREATE TABLE public.cuba_landmask (geom text);

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
$function$
;

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
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public.platform_config_is_secret(p_key text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT p_key NOT ILIKE '%publishable%'
     AND (
       p_key ~ '(_token|_secret|_signature|_hash|_api_key|_password)$'
       OR p_key IN (
         'eltoque_api_token',
         'infobip_api_key',
         'openweather_api_key',
         'smspm_token',
         'smspm_hash',
         'netopia_live_signature',
         'netopia_sandbox_signature'
       )
     );
$function$
;

CREATE OR REPLACE FUNCTION public.platform_config_can_read_secrets()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(is_admin(), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$
;

-- LIVE pc_select (00517)
CREATE POLICY pc_select ON public.platform_config FOR SELECT
  USING (((NOT platform_config_is_secret(key)) OR platform_config_can_read_secrets()));

CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric DEFAULT NULL::numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;

  -- `#>> '{}'` unwraps the JSONB scalar safely whether it was written
  -- as a string ('"0.15"') or as a JSON number (0.15). Cast to NUMERIC
  -- after.
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;

  RETURN COALESCE(v_out, p_fallback);
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.get_weather_surge()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled TEXT;
  v_mult NUMERIC;
BEGIN
  SELECT (value #>> '{}') INTO v_enabled FROM platform_config WHERE key = 'weather_surge_enabled';
  IF v_enabled IS NOT NULL AND lower(v_enabled) = 'false' THEN
    RETURN 1.0;
  END IF;
  v_mult := get_platform_config_numeric('weather_surge_multiplier', 1.0);
  RETURN LEAST(GREATEST(COALESCE(v_mult, 1.0), 1.0), 3.0);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.preview_cancellation_penalty(p_user_id uuid)
 RETURNS TABLE(penalty_amount integer, is_blocked boolean, cancel_count_24h integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cancel_count_24h INTEGER;
  v_penalty INTEGER := 0;
  v_blocked BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_cancel_count_24h
  FROM cancellation_penalties
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '24 hours';

  IF v_cancel_count_24h >= 4 THEN
    v_penalty := 200;
    v_blocked := true;
  ELSIF v_cancel_count_24h >= 2 THEN
    v_penalty := 200;
  ELSIF v_cancel_count_24h >= 1 THEN
    v_penalty := 100;
  ELSE
    v_penalty := 0;
  END IF;

  RETURN QUERY SELECT v_penalty, v_blocked, v_cancel_count_24h;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_cuba_landmask()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.cuba_landmask;
  INSERT INTO public.cuba_landmask (geom)
  SELECT ST_Subdivide(ST_Buffer(ST_Union(a.geom)::geography, 2000)::geometry, 256)
  FROM public.cuba_admin_areas a
  WHERE a.admin_level = 4;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ANALYZE public.cuba_landmask;
  RETURN v_n;
END;
$function$
;

-- LIVE ACLs (proacl on 2026-10-06). PUBLIC keeps its default EXECUTE where prod has it.
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric(text, numeric) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_platform_config_text(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_cancellation_penalty(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_config_can_read_secrets() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_cuba_landmask() TO service_role;
REVOKE ALL ON FUNCTION public.get_weather_surge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_weather_surge() TO service_role, anon, authenticated;

RESET ROLE;
