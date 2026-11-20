-- Scaffold of the rehearsal of migration <number>: the objects the migration touches, copied from
-- production (scripts/sql/live-definitions.sql prints their current definitions and md5). Keep it
-- minimal: only what the migration and tests.sql read or write.
SET client_min_messages = warning;

-- Supabase roles. postgres owns the objects and applies the migration, without superuser (as in
-- production). Roles are shared by every database of the server, so create them only once.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
GRANT CREATE, USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- The live objects of this migration go below, created by their owner:
SET ROLE postgres;
-- CREATE TABLE public.something (...);   -- copied from production
RESET ROLE;
