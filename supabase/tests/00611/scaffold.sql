-- Scaffold for the 00611 rehearsal: public.users with the columns, policies and
-- column grants that matter, read from prod on 2026-10-06, and the LIVE bodies of
-- auth.uid(), current_user_role() and is_admin() (00592), byte-exact from the 00608
-- scaffold. No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the migration
-- as that role.
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

-- public.users: only the columns this migration and its tests touch
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  email text,
  email_verified_at timestamp with time zone
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- LIVE column grants: authenticated may UPDATE email and email_verified_at
GRANT SELECT ON public.users TO anon, authenticated;
GRANT UPDATE (full_name, email, email_verified_at) ON public.users TO authenticated;
GRANT ALL ON public.users TO service_role;

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

REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE policies on users for SELECT and UPDATE (users_update_own has no WITH CHECK)
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid)));

INSERT INTO public.users (id, role, full_name, email, email_verified_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer', 'Ana', 'ana@example.com', NULL),
  ('b0000000-0000-4000-8000-000000000002', 'customer', 'Beto', 'beto@example.com', '2026-10-01 12:00:00+00'),
  ('c0000000-0000-4000-8000-000000000003', 'admin',    'Cora', 'cora@example.com', NULL);

RESET ROLE;
