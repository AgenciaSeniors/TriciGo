-- Scaffold for the 00606 rehearsal: the LIVE production shapes of platform_config,
-- admin_actions and the audit trigger, transcribed from pg_get_functiondef,
-- information_schema, pg_constraint and pg_policies on 2026-10-06 (00605 applied).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST sets it.
--
-- Ownership mirrors prod: a NON-superuser role (prod: postgres) owns the tables and
-- functions and run.sh applies the migration as that role. A superuser would bypass
-- the RLS that check R1-R3 exercise.
--
-- Not modelled: the rest of public.users (only id and role matter to is_admin) and
-- the user_role values that no check uses. The function bodies are byte-identical
-- to prod; run.sh S0 compares md5(prosrc) with the values read from prod.
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
-- 00007 seeds the platform account in every database built from the history.
INSERT INTO public.users (id, role) VALUES ('00000000-0000-0000-0000-000000000001', 'super_admin');

-- LIVE public.platform_config (columns, PK, RLS on, not forced)
CREATE TABLE public.platform_config (
  key text NOT NULL PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

-- LIVE public.admin_actions (columns, PK, FK, RLS on, not forced, policies, grants)
CREATE TABLE public.admin_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.admin_actions TO anon, authenticated, service_role;
GRANT SELECT ON public.users TO anon, authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public._platform_config_audit_value(p_value jsonb, p_is_secret boolean)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_value IS NULL THEN NULL
    WHEN p_is_secret THEN jsonb_build_object(
      'redacted', true,
      'sha256_12', left(encode(sha256(convert_to(p_value::text, 'UTF8')), 'hex'), 12))
    ELSE jsonb_build_object('value', p_value)
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_platform_config_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin UUID := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid);
  v_secret boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_secret := public.platform_config_is_secret(NEW.key);
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'insert_platform_config', 'platform_config', NEW.key, NULL,
            public._platform_config_audit_value(NEW.value, v_secret));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Skip if nothing meaningful changed.
    IF OLD.value IS DISTINCT FROM NEW.value THEN
      v_secret := public.platform_config_is_secret(OLD.key) OR public.platform_config_is_secret(NEW.key);
      INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
      VALUES (v_admin, 'update_platform_config', 'platform_config', NEW.key,
              public._platform_config_audit_value(OLD.value, v_secret),
              public._platform_config_audit_value(NEW.value, v_secret));
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_secret := public.platform_config_is_secret(OLD.key);
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (v_admin, 'delete_platform_config', 'platform_config', OLD.key,
            public._platform_config_audit_value(OLD.value, v_secret), NULL);
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$
;

-- LIVE policies on admin_actions
CREATE POLICY aa_insert ON public.admin_actions FOR INSERT
  WITH CHECK ((is_admin() AND (admin_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY aa_select ON public.admin_actions FOR SELECT
  USING (is_admin());

-- LIVE trigger on platform_config (the only one)
CREATE TRIGGER platform_config_audit AFTER INSERT OR DELETE OR UPDATE ON public.platform_config
  FOR EACH ROW EXECUTE FUNCTION public.tg_platform_config_audit();

RESET ROLE;
