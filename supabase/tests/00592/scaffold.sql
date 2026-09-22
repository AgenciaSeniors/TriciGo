-- Scaffold for the 00592 rehearsal: the LIVE production shapes involved in the
-- 2026-09-21 "permission denied for function current_user_role" failures,
-- transcribed from pg_get_functiondef / pg_policies on 2026-09-22. No Supabase
-- stack: auth.uid() is stubbed on request.jwt.claim.sub like PostgREST sets it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  full_name text,
  role public.user_role NOT NULL DEFAULT 'customer'
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated, service_role;

-- LIVE: SECURITY DEFINER, and `anon` has no EXECUTE on it (ACL
-- {postgres=X, authenticated=X, service_role=X}) since 00517.
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS public.user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE (pre-00592): SECURITY INVOKER, so the call to current_user_role() runs
-- as the requesting role. Executable by anon, which is exactly how anon reaches
-- the function it may not execute.
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT current_user_role() IN ('admin', 'super_admin');
$function$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- LIVE policies on users
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());

-- LIVE policies on blog_posts: the admin one subqueries users, whose policy
-- calls is_admin(). This is the public blog SSR path (anon client).
CREATE TABLE public.blog_posts (id serial PRIMARY KEY, slug text NOT NULL, is_published boolean NOT NULL DEFAULT false);
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.blog_posts TO anon, authenticated, service_role;
CREATE POLICY blog_posts_public_read ON public.blog_posts FOR SELECT USING (is_published = true);
CREATE POLICY blog_posts_admin_all ON public.blog_posts FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))
);

-- driver_profiles with the dp_update_own shape ("user_id = auth.uid() OR is_admin()"):
-- the "Conectarme" UPDATE of the driver app.
CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL, is_online boolean NOT NULL DEFAULT false);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.driver_profiles TO anon, authenticated, service_role;
CREATE POLICY dp_select ON public.driver_profiles FOR SELECT USING (user_id = auth.uid() OR is_admin());
CREATE POLICY dp_update_own ON public.driver_profiles FOR UPDATE USING (user_id = auth.uid() OR is_admin());

INSERT INTO public.users (id, full_name, role) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alice (customer)', 'customer'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Bob (driver)', 'driver'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Carol (admin)', 'admin');
INSERT INTO public.driver_profiles (id, user_id) VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.blog_posts (slug, is_published) VALUES ('hola-cuba', true), ('borrador', false);
