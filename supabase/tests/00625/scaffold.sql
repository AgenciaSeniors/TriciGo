-- Scaffold for the 00625 rehearsal: corporate_accounts, corporate_employees,
-- wallet_accounts, rides and corporate_rides with the columns, constraints, grants,
-- policies and triggers read from prod on 2026-10-07, and the LIVE bodies of auth.uid(),
-- current_user_role(), is_admin() (00592), is_corp_admin(), update_updated_at_column(),
-- tg_corporate_accounts_protect_admin_fields() and tg_rides_validate_corporate().
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST, and the cron
-- schema is a stub with pg_cron's job table and schedule/unschedule. A NON-superuser role
-- (prod: postgres) owns everything; run.sh applies the migration as that role.
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

-- pg_cron stub: the job table and the two functions the migration calls. Like pg_cron,
-- unschedule raises on an unknown job name, and schedule upserts by name.
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text UNIQUE
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$f$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', job_name; END IF;
  RETURN true;
END
$f$;
GRANT USAGE ON SCHEMA cron TO tricigo_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON cron.job TO tricigo_owner;
GRANT USAGE ON SEQUENCE cron.job_jobid_seq TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold',
  'platform_revenue', 'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin',
  'platform_fx_reserve');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

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

-- corporate_accounts: LIVE columns, constraints, grants, policies and triggers.
CREATE TABLE public.corporate_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL,
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
  commission_percent numeric DEFAULT NULL::numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false,
  CONSTRAINT corporate_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text]))),
  CONSTRAINT corporate_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_commission_range
  CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))) NOT VALID;
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
CREATE POLICY corporate_accounts_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY corporate_accounts_corp_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM corporate_employees WHERE corporate_employees.corporate_account_id = corporate_accounts.id
    AND corporate_employees.user_id = auth.uid() AND corporate_employees.role = 'admin'::text AND corporate_employees.is_active = true));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_employee_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM corporate_employees WHERE corporate_employees.corporate_account_id = corporate_accounts.id
    AND corporate_employees.user_id = auth.uid() AND corporate_employees.is_active = true));
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY corporate_employees_corp_admin_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (is_corp_admin(corporate_account_id) OR (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid()
    AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))));
CREATE POLICY corporate_employees_self_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_corporate_update', true) = '1' THEN
    NEW.status              := OLD.status;
    NEW.commission_percent  := OLD.commission_percent;
    NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
    NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
    NEW.is_fleet_owner      := OLD.is_fleet_owner;
    NEW.approved_at         := OLD.approved_at;
    NEW.suspended_at        := OLD.suspended_at;
    NEW.suspended_reason    := OLD.suspended_reason;
    NEW.created_by          := OLD.created_by;
    NEW.id                  := OLD.id;
    NEW.created_at          := OLD.created_at;
    RETURN NEW;
  END IF;

  NEW.status              := OLD.status;
  NEW.commission_percent  := OLD.commission_percent;
  NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
  NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
  NEW.current_month_spent := OLD.current_month_spent;
  NEW.is_fleet_owner      := OLD.is_fleet_owner;
  NEW.approved_at         := OLD.approved_at;
  NEW.suspended_at        := OLD.suspended_at;
  NEW.suspended_reason    := OLD.suspended_reason;
  NEW.created_by          := OLD.created_by;
  NEW.id                  := OLD.id;
  NEW.created_at          := OLD.created_at;
  RETURN NEW;
END;
$function$
;

CREATE TRIGGER set_corporate_accounts_updated_at BEFORE UPDATE ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_corporate_accounts_protect_admin_fields BEFORE UPDATE ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_corporate_accounts_protect_admin_fields();

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

-- rides: only the columns tg_rides_validate_corporate and the tests touch. The LIVE
-- partial index on corporate_account_id and the LIVE trigger definition.
CREATE TABLE public.rides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid,
  status public.ride_status NOT NULL DEFAULT 'searching'::ride_status,
  payment_method public.payment_method NOT NULL DEFAULT 'cash'::payment_method,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_fare_trc integer,
  final_fare_trc integer,
  corporate_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rides_corporate_account ON public.rides USING btree (corporate_account_id) WHERE (corporate_account_id IS NOT NULL);
GRANT ALL ON public.rides TO service_role;

CREATE TABLE public.corporate_rides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  employee_user_id uuid NOT NULL REFERENCES public.users(id),
  fare_trc integer NOT NULL CONSTRAINT corporate_rides_fare_trc_nonneg CHECK ((fare_trc >= 0)),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.corporate_rides ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.corporate_rides TO service_role;

CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  v_per_ride_cap integer;
  v_monthly_budget integer;
  v_month_spent integer;
  v_fare integer;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    IF NEW.payment_method = 'corporate' THEN
      RAISE EXCEPTION 'corporate payment_method requires a corporate_account_id';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, per_ride_cap_trc, monthly_budget_trc
    INTO v_status, v_per_ride_cap, v_monthly_budget
  FROM corporate_accounts WHERE id = NEW.corporate_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'corporate account % not found', NEW.corporate_account_id;
  END IF;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'corporate account % is not approved (status=%)', NEW.corporate_account_id, v_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'customer % is not an active employee of corporate account %',
      NEW.customer_id, NEW.corporate_account_id;
  END IF;

  v_fare := COALESCE(NULLIF(NEW.estimated_fare_trc, 0), NULLIF(NEW.estimated_fare_cup, 0), 0);
  IF TG_OP = 'INSERT' AND v_fare <= 0 THEN
    RAISE EXCEPTION 'corporate ride requires a positive fare estimate to enforce caps/budget';
  END IF;

  IF COALESCE(v_per_ride_cap, 0) > 0 AND v_fare > v_per_ride_cap THEN
    RAISE EXCEPTION 'ride fare % exceeds corporate per-ride cap %', v_fare, v_per_ride_cap;
  END IF;

  IF TG_OP = 'INSERT' AND COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    IF v_month_spent + v_fare > v_monthly_budget THEN
      RAISE EXCEPTION 'corporate account % would exceed its monthly budget (spent % + ride % > budget %)',
        NEW.corporate_account_id, v_month_spent, v_fare, v_monthly_budget;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE TRIGGER trg_rides_validate_corporate BEFORE INSERT OR UPDATE OF corporate_account_id, payment_method, estimated_fare_trc
  ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_corporate();

RESET ROLE;

-- Seed.
--   Ana created companies A, C (both approved) and P (pending); she administers all three,
--     and they share her corporate wallet: 5000 with 100 held.
--   Beto is the second admin of A and created company D, approved, with no corporate wallet.
--   Cora is an employee of A, C, P and D, not an admin. Fede is a former employee of A.
--   Dani created company B (approved, wallet 777). Eva is a platform admin.
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
INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'Empresa A', '+5350000001', 'approved', 'a0000000-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-00000000000c', 'Empresa C', '+5350000001', 'approved', 'a0000000-0000-4000-8000-000000000001'),
  ('99999999-0000-4000-8000-000000000009', 'Empresa P', '+5350000001', 'pending', 'a0000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'Empresa B', '+5350000004', 'approved', 'd0000000-0000-4000-8000-000000000004'),
  ('dddddddd-0000-4000-8000-00000000000d', 'Empresa D', '+5350000002', 'approved', 'b0000000-0000-4000-8000-000000000002');
INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, is_active, added_by) VALUES
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'a0000000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'a0000000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-000000000006', 'employee', false, 'a0000000-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'a0000000-0000-4000-8000-000000000001'),
  ('99999999-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'admin', true, 'a0000000-0000-4000-8000-000000000001'),
  ('99999999-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'a0000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'd0000000-0000-4000-8000-000000000004', 'admin', true, 'd0000000-0000-4000-8000-000000000004'),
  ('dddddddd-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000002', 'admin', true, 'b0000000-0000-4000-8000-000000000002'),
  ('dddddddd-0000-4000-8000-00000000000d', 'c0000000-0000-4000-8000-000000000003', 'employee', true, 'b0000000-0000-4000-8000-000000000002');
INSERT INTO public.wallet_accounts (user_id, account_type, balance, held_balance) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'corporate_cash', 5000, 100),
  ('a0000000-0000-4000-8000-000000000001', 'customer_cash', 42, 0),
  ('d0000000-0000-4000-8000-000000000004', 'corporate_cash', 777, 0);
