-- Local rehearsal scaffold for migration 00598 (register_corporate_account).
-- Minimal prod-shaped schema. Everything marked LIVE is a verbatim copy of
-- pg_get_functiondef() / pg_policies captured from production on 2026-09-27,
-- and the function ACLs reproduce what has_function_privilege() reported that
-- day. Only the INSERT and SELECT policies of the corporate tables are
-- reproduced: the function under test inserts, and the checks read.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

-- LIVE
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

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash','driver_cash','driver_hold','platform_revenue','platform_promotions','corporate_cash','driver_quota','tricicoin','platform_fx_reserve');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  full_name text
);

-- LIVE
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
$function$;

-- LIVE (00592)
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
$function$;

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC',
  is_active boolean NOT NULL DEFAULT true,
  anchor_usd_cents numeric,
  unbacked_cup integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_accounts_user_id_account_type_key UNIQUE (user_id, account_type),
  CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (account_type <> 'customer_cash' OR balance >= 0),
  CONSTRAINT chk_anchor_usd_cents_nonneg CHECK (anchor_usd_cents IS NULL OR anchor_usd_cents >= 0),
  CONSTRAINT chk_unbacked_cup_nonneg CHECK (unbacked_cup >= 0)
);
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
-- LIVE policies
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY wa_admin ON public.wallet_accounts FOR ALL USING (is_admin());

-- LIVE (00591)
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type wallet_account_type DEFAULT 'customer_cash'::wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id  UUID;
  v_uid UUID;
  v_ctx TEXT;
BEGIN
  -- 00591: a DIRECT call (PostgREST RPC from a signed-in, non-admin user)
  -- may only create the caller's own spendable accounts. Internal callers
  -- (send_gift, complete_ride_and_pay, admin_send_gift, the referral and
  -- corporate triggers, ...) are PL/pgSQL functions, so for them PG_CONTEXT
  -- carries at least one more frame below this one; a direct call has
  -- exactly one frame and therefore no newline. Service-role/cron callers
  -- have auth.uid() IS NULL and admins are exempt.
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF position(E'\n' IN v_ctx) = 0 AND NOT is_admin() THEN
      IF p_user_id IS DISTINCT FROM v_uid
         OR p_type NOT IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN
        RAISE EXCEPTION 'forbidden: ensure_wallet_account may only create your own customer_cash, tricicoin or corporate_cash account'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;

-- LIVE columns and constraints
CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending',
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
  commission_percent numeric DEFAULT NULL::numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false,
  CONSTRAINT corporate_accounts_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text])),
  CONSTRAINT corporate_accounts_commission_range CHECK (commission_percent IS NULL OR (commission_percent >= 0::numeric AND commission_percent <= 100::numeric))
);

CREATE TABLE public.corporate_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  role text NOT NULL DEFAULT 'employee',
  is_active boolean NOT NULL DEFAULT true,
  added_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT corporate_employees_role_check CHECK (role = ANY (ARRAY['admin'::text, 'employee'::text])),
  CONSTRAINT corporate_employees_corporate_account_id_user_id_key UNIQUE (corporate_account_id, user_id)
);

-- LIVE
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
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.corp_has_no_employees(p_account_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM corporate_employees WHERE corporate_account_id = p_account_id
  );
$function$;

-- LIVE
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
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_corporate_update', true) = '1' THEN RETURN NEW; END IF;

  NEW.status              := 'pending';
  NEW.is_fleet_owner      := false;
  NEW.commission_percent  := NULL;
  NEW.current_month_spent := 0;
  NEW.approved_at         := NULL;
  NEW.suspended_at        := NULL;
  NEW.suspended_reason    := NULL;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_corporate_accounts_protect_insert BEFORE INSERT ON public.corporate_accounts
  FOR EACH ROW EXECUTE FUNCTION tg_corporate_accounts_protect_insert();

ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.corporate_employees ENABLE ROW LEVEL SECURITY;

-- LIVE policies (INSERT and SELECT)
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_employee_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM corporate_employees
                  WHERE corporate_employees.corporate_account_id = corporate_accounts.id
                    AND corporate_employees.user_id = auth.uid()
                    AND corporate_employees.is_active = true));

CREATE POLICY corporate_employees_bootstrap_creator ON public.corporate_employees FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid() AS uid) AND role = 'admin'::text AND is_active = true
              AND corp_is_creator(corporate_account_id) AND corp_has_no_employees(corporate_account_id));
CREATE POLICY corporate_employees_corp_admin_insert ON public.corporate_employees FOR INSERT TO authenticated
  WITH CHECK (is_corp_admin(corporate_account_id) OR is_admin());
CREATE POLICY corporate_employees_corp_admin_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (is_corp_admin(corporate_account_id)
         OR EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY corporate_employees_self_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- Function ACLs as production reported them on 2026-09-27.
REVOKE ALL ON FUNCTION public.ensure_wallet_account(uuid, wallet_account_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_wallet_account(uuid, wallet_account_type) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_corp_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_corp_admin(uuid) TO authenticated, service_role;

INSERT INTO public.users (id, role, full_name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'customer', 'Alice'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'customer', 'Bob'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'admin', 'Carol'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'driver', 'Dave');
