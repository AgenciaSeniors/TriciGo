-- Scaffold for the 00616 rehearsal: public.users with the RLS policies and grants that let
-- a signed-in user update their own row in prod (table-level UPDATE for authenticated,
-- users_update_own without WITH CHECK), and auth.uid() reading request.jwt.claim.sub like
-- PostgREST (LIVE body, from the 00612 scaffold). Only the columns the tests touch.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the migration as it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, tricigo_owner TO pgtest;
GRANT authenticated TO tricigo_owner;
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

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

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  full_name text
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.users TO authenticated;
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY users_update_own ON public.users FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid)));

RESET ROLE;
