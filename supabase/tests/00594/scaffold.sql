-- Scaffold for the 00594 rehearsal: the LIVE production shapes of
-- auth_revocations and cleanup_auth_revocations(), transcribed on 2026-09-25
-- from information_schema, pg_policy and pg_get_functiondef. The function body
-- below is byte for byte the one running in prod (md5(prosrc)
-- 8fa2316a52152feef7d71eb2b51447db, length 213; identical to 00297).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Stub: the table's only policy calls it. Nobody in this rehearsal is an admin.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

-- LIVE table: no FK, no triggers, RLS on with a single SELECT policy.
-- Table grants are Supabase's defaults (every role, every privilege).
CREATE TABLE public.auth_revocations (
  user_id    uuid PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason     text
);
ALTER TABLE public.auth_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_revocations_self_read ON public.auth_revocations
  FOR SELECT USING ((user_id = (SELECT auth.uid() AS uid)) OR is_admin());
GRANT ALL ON public.auth_revocations TO anon, authenticated, service_role;

-- LIVE (pre-00594): the RETURNING ... INTO raises TOO_MANY_ROWS as soon as the
-- DELETE matches 2+ rows. ACL {postgres=X, service_role=X}.
CREATE OR REPLACE FUNCTION public.cleanup_auth_revocations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM auth_revocations
  WHERE revoked_at < now() - interval '24 hours'
  RETURNING 1 INTO v_deleted;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.cleanup_auth_revocations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_auth_revocations() TO service_role;

-- Production's backlog shape: nothing but stale rows (62 on 2026-09-25, the
-- oldest from 2026-07-09). Four here; the tests reseed as they need.
INSERT INTO public.auth_revocations (user_id, revoked_at, reason) VALUES
  ('11111111-1111-4111-8111-111111111111', '2026-07-09 11:26:58+00', 'signout'),
  ('22222222-2222-4222-8222-222222222222', '2026-08-14 09:00:00+00', 'signout'),
  ('33333333-3333-4333-8333-333333333333', now() - interval '3 days', 'signout'),
  ('44444444-4444-4444-8444-444444444444', now() - interval '2 hours', 'signout');
