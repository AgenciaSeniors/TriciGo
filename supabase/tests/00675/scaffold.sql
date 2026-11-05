-- Scaffold for the 00675 rehearsal: users, corporate_accounts and corporate_employees with
-- the columns, keys, grants and EVERY policy read from prod on 2026-11-05, and the LIVE
-- bodies of auth.uid(), current_user_role(), is_admin() (00592), is_marketing() (00642),
-- is_operator() (00668), is_corp_admin(), corp_is_creator() and corp_has_no_employees().
-- The recursion comes from how the policies of these tables refer to each other, so all of
-- them are here, verbatim. No Supabase stack: auth.uid() reads request.jwt.claim.sub like
-- PostgREST. A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role.
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

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');

-- public.users: only the columns the functions and tests read. LIVE policies and grants.
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  phone text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.users TO anon, authenticated;
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

CREATE OR REPLACE FUNCTION public.is_marketing()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$function$
;
REVOKE ALL ON FUNCTION public.is_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_operator()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is an operator, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'operator';
END;
$function$
;
REVOKE ALL ON FUNCTION public.is_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_operator() TO anon, authenticated, service_role;

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_marketing ON public.users FOR SELECT TO authenticated USING (( SELECT is_marketing() AS is_marketing));
CREATE POLICY users_select_operator ON public.users FOR SELECT TO authenticated USING (( SELECT is_operator() AS is_operator));
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = ( SELECT auth.uid() AS uid));

-- corporate_accounts: the LIVE columns these tests touch, grants and every policy.
CREATE TABLE public.corporate_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  contact_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending', 'approved', 'suspended', 'rejected'])),
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.corporate_accounts TO anon, authenticated, service_role;

-- corporate_employees: LIVE columns, keys and grants. The key on (account, user) is the
-- partial index of 00657, which is why PostgREST cannot upsert it.
CREATE TABLE public.corporate_employees (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  role text NOT NULL DEFAULT 'employee' CHECK (role = ANY (ARRAY['admin', 'employee'])),
  is_active boolean NOT NULL DEFAULT true,
  added_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX corporate_employees_corporate_account_id_user_id_key
  ON public.corporate_employees (corporate_account_id, user_id)
  WHERE user_id <> '00000000-0000-0000-0000-000000000099'::uuid;
CREATE INDEX idx_corporate_employees_user_id ON public.corporate_employees (user_id);
ALTER TABLE public.corporate_employees ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.corporate_employees TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_corp_admin(p_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM corporate_employees
    WHERE corporate_account_id = p_account_id
      AND user_id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$function$
;

CREATE OR REPLACE FUNCTION public.corp_is_creator(p_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM corporate_accounts
    WHERE id = p_account_id AND created_by = auth.uid()
  );
$function$
;

CREATE OR REPLACE FUNCTION public.corp_has_no_employees(p_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM corporate_employees WHERE corporate_account_id = p_account_id
  );
$function$
;

CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_corp_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1
   FROM corporate_employees
  WHERE ((corporate_employees.corporate_account_id = corporate_accounts.id) AND (corporate_employees.user_id = auth.uid()) AND (corporate_employees.role = 'admin'::text) AND (corporate_employees.is_active = true))));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_employee_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1
   FROM corporate_employees
  WHERE ((corporate_employees.corporate_account_id = corporate_accounts.id) AND (corporate_employees.user_id = auth.uid()) AND (corporate_employees.is_active = true))));
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY corporate_accounts_select_operator ON public.corporate_accounts FOR SELECT TO authenticated
  USING (( SELECT is_operator() AS is_operator));

CREATE POLICY corporate_employees_bootstrap_creator ON public.corporate_employees FOR INSERT TO authenticated
  WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)) AND (role = 'admin'::text) AND (is_active = true)
    AND corp_is_creator(corporate_account_id) AND corp_has_no_employees(corporate_account_id));
CREATE POLICY corporate_employees_corp_admin_delete ON public.corporate_employees FOR DELETE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM corporate_employees ce
  WHERE ((ce.corporate_account_id = corporate_employees.corporate_account_id) AND (ce.user_id = auth.uid()) AND (ce.role = 'admin'::text) AND (ce.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_employees_corp_admin_insert ON public.corporate_employees FOR INSERT TO authenticated
  WITH CHECK (is_corp_admin(corporate_account_id) OR is_admin());
CREATE POLICY corporate_employees_corp_admin_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (is_corp_admin(corporate_account_id) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_employees_corp_admin_update ON public.corporate_employees FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM corporate_employees ce
  WHERE ((ce.corporate_account_id = corporate_employees.corporate_account_id) AND (ce.user_id = auth.uid()) AND (ce.role = 'admin'::text) AND (ce.is_active = true)))) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_employees_select_operator ON public.corporate_employees FOR SELECT TO authenticated
  USING (( SELECT is_operator() AS is_operator));
CREATE POLICY corporate_employees_self_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

RESET ROLE;

-- Seed. Ana created company A and is its admin; Beto is A's second admin and created company
-- D; Cora is an employee of A; Fede a former employee of A; Dani created company B; Eva is a
-- platform admin; Olga an operator; Gil belongs to no company; …0099 is the anonymous user
-- that account deletion moves references to.
INSERT INTO public.users (id, role, full_name, phone) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer', 'Ana', '+5350000001'),
  ('b0000000-0000-4000-8000-000000000002', 'customer', 'Beto', '+5350000002'),
  ('c0000000-0000-4000-8000-000000000003', 'customer', 'Cora', '+5350000003'),
  ('d0000000-0000-4000-8000-000000000004', 'customer', 'Dani', '+5350000004'),
  ('e0000000-0000-4000-8000-000000000005', 'admin', 'Eva', '+5350000005'),
  ('f0000000-0000-4000-8000-000000000006', 'driver', 'Fede', '+5350000006'),
  ('10000000-0000-4000-8000-000000000007', 'customer', 'Gil', '+5350000007'),
  ('20000000-0000-4000-8000-000000000008', 'operator', 'Olga', '+5350000008'),
  ('00000000-0000-0000-0000-000000000099', 'customer', 'Cuenta eliminada', NULL);
INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Empresa A', '+5350000001', 'approved', 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Empresa B', '+5350000004', 'approved', 'd0000000-0000-4000-8000-000000000004', now() - interval '3 days'),
  ('dddddddd-0000-4000-8000-00000000000d', 'Empresa D', '+5350000002', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days');
INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, is_active, added_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-000000000006', 'employee', false, 'a0000000-0000-4000-8000-000000000001', now() - interval '12 hours'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-000000000004', 'admin', true, 'd0000000-0000-4000-8000-000000000004', now() - interval '3 days'),
  ('dddddddd-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days');
