-- Scaffold for the 00624 rehearsal: corporate_accounts, corporate_employees and
-- wallet_accounts with the columns, constraints, grants and policies read from prod on
-- 2026-10-07, and the LIVE bodies of auth.uid(), current_user_role(), is_admin() (00592)
-- and is_corp_admin(). No Supabase stack: auth.uid() reads request.jwt.claim.sub like
-- PostgREST. A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role. users and auth.users carry only what the functions read.
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
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold',
  'platform_revenue', 'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin',
  'platform_fx_reserve');

CREATE TABLE auth.users (id uuid PRIMARY KEY);

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

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());

-- corporate_accounts: LIVE columns, constraints, grants and SELECT/UPDATE policies.
CREATE TABLE public.corporate_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending', 'approved', 'suspended', 'rejected'])),
  created_by uuid NOT NULL REFERENCES public.users(id),
  monthly_budget_trc integer NOT NULL DEFAULT 0,
  per_ride_cap_trc integer NOT NULL DEFAULT 0,
  allowed_service_types text[] DEFAULT '{}'::text[],
  allowed_hours_start time without time zone,
  allowed_hours_end time without time zone,
  current_month_spent integer NOT NULL DEFAULT 0,
  approved_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  commission_percent numeric DEFAULT NULL,
  is_fleet_owner boolean NOT NULL DEFAULT false
);
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.corporate_accounts TO anon, authenticated, service_role;

CREATE TABLE public.corporate_employees (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  role text NOT NULL DEFAULT 'employee' CHECK (role = ANY (ARRAY['admin', 'employee'])),
  is_active boolean NOT NULL DEFAULT true,
  added_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (corporate_account_id, user_id)
);
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

CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_employee_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM corporate_employees WHERE corporate_employees.corporate_account_id = corporate_accounts.id
    AND corporate_employees.user_id = auth.uid() AND corporate_employees.is_active = true));

CREATE POLICY corporate_employees_corp_admin_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (is_corp_admin(corporate_account_id) OR (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
    AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))));
CREATE POLICY corporate_employees_self_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- wallet_accounts: the LIVE columns that matter here, the unique key and the policies.
CREATE TABLE public.wallet_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.wallet_accounts TO anon, authenticated, service_role;
CREATE POLICY wa_admin ON public.wallet_accounts USING (is_admin());
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)) OR is_admin());

RESET ROLE;

-- Seed. Ana created company A; Beto is its second admin; Cora an employee; Fede a former
-- employee; Dani created company B; Eva is a platform admin. Ana also created company C,
-- so A and C share her corporate wallet (it is keyed by the creator). Beto created company
-- D and has no corporate wallet yet.
INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000003'), ('d0000000-0000-4000-8000-000000000004'),
  ('e0000000-0000-4000-8000-000000000005'), ('f0000000-0000-4000-8000-000000000006');
INSERT INTO public.users (id, role, full_name, phone) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer', 'Ana', '+5350000001'),
  ('b0000000-0000-4000-8000-000000000002', 'customer', 'Beto', '+5350000002'),
  ('c0000000-0000-4000-8000-000000000003', 'customer', 'Cora', '+5350000003'),
  ('d0000000-0000-4000-8000-000000000004', 'customer', 'Dani', '+5350000004'),
  ('e0000000-0000-4000-8000-000000000005', 'admin', 'Eva', '+5350000005'),
  ('f0000000-0000-4000-8000-000000000006', 'driver', 'Fede', '+5350000006');
INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Empresa A', '+5350000001', 'approved', 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Empresa B', '+5350000004', 'approved', 'd0000000-0000-4000-8000-000000000004', now() - interval '3 days'),
  ('cccccccc-0000-4000-8000-00000000000c', 'Empresa C', '+5350000001', 'pending', 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('dddddddd-0000-4000-8000-00000000000d', 'Empresa D', '+5350000002', 'approved', 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days');
INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, is_active, added_by, created_at) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-000000000006', 'employee', false, 'a0000000-0000-4000-8000-000000000001', now() - interval '12 hours'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-000000000004', 'admin', true, 'd0000000-0000-4000-8000-000000000004', now() - interval '3 days'),
  ('cccccccc-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('dddddddd-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'b0000000-0000-4000-8000-000000000002', now() - interval '3 days');
INSERT INTO public.wallet_accounts (user_id, account_type, balance, held_balance) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'corporate_cash', 5000, 100),
  ('a0000000-0000-4000-8000-000000000001', 'customer_cash', 42, 0),
  ('d0000000-0000-4000-8000-000000000004', 'corporate_cash', 777, 0);
