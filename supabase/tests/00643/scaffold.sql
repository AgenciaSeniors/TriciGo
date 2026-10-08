-- Scaffold for the 00643 rehearsal: the tables get_my_email_status reads (public.users,
-- public.email_verification_tokens, auth.identities) with their prod columns, and the two
-- 00635 helpers with their LIVE bodies (run.sh S0 compares md5/length with prod).
--
-- The owner is a NON-superuser role named postgres, as in prod, member of anon,
-- authenticated and service_role. The cluster's superuser is pgtest; run.sh applies the
-- migration as postgres. No Supabase stack: auth.uid() reads request.jwt.claim.sub like
-- PostgREST sets it. The default privileges at the end give every new function EXECUTE
-- for the three API roles, as prod does today.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- auth.identities: the columns the helpers read (prod: owned by supabase_auth_admin, postgres can SELECT)
CREATE TABLE auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  provider_id text NOT NULL DEFAULT gen_random_uuid()::text,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  full_name text,
  email text,
  email_verified_at timestamp with time zone
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated, service_role;

-- 00568, prod columns. RLS on with no policy for the API roles: only service_role reads it.
CREATE TABLE public.email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.email_verification_tokens ENABLE ROW LEVEL SECURITY;

-- 00635 helpers, verbatim (prod md5 58def924…/479 and 99a0551a…/72, checked 2026-10-08)
CREATE OR REPLACE FUNCTION public.mailable_user_emails(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public._user_mailable_email(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT m.email FROM public.mailable_user_emails(ARRAY[p_user_id]) m;
$fn$;

REVOKE ALL ON FUNCTION public.mailable_user_emails(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailable_user_emails(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public._user_mailable_email(uuid) FROM PUBLIC, anon, authenticated, service_role;

RESET ROLE;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
