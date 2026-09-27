-- Scaffold for the fleet review race rehearsal (supabase/tests/fleet-review/run.sh).
-- The LIVE production shapes of users, corporate_accounts, driver_fleets and
-- fleet_members, with their RLS policies and table grants, the triggers on the
-- paths the rehearsal runs, and the functions those paths call, transcribed on
-- 2026-09-27 from pg_policy, pg_trigger, information_schema.role_table_grants
-- and pg_get_functiondef, and re-checked the same day after 00600 was applied.
-- Left out, since nothing here fires them: the updated_at triggers on
-- corporate_accounts and driver_fleets, and
-- trg_corporate_accounts_protect_admin_fields (no corporate_accounts UPDATE).
-- 00598 (the approval link) is not in prod yet and is not here: it only fires
-- on a row the approve's WHERE already matched, so it cannot change a count.
-- The bodies of tg_fleet_members_protect() (00600), is_admin() (00592),
-- current_user_role() and tg_corporate_accounts_protect_insert() are byte for
-- byte the ones running in prod; run.sh asserts their md5(prosrc), and the
-- policies of the three fleet tables as prod deparses them. Only the columns
-- these paths read are kept on public.users, with its two SELECT policies (no
-- client writes it here), and corporate_employees carries just what the
-- corporate_accounts policies look up (it is empty).
-- All three fleet tables had 0 rows in prod.
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

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');

CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- LIVE public.users, trimmed to the columns these paths read.
CREATE TABLE public.users (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text,
  role       public.user_role NOT NULL DEFAULT 'customer'::user_role,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO anon, authenticated, service_role;

-- LIVE: SECURITY DEFINER, EXECUTE for authenticated and service_role only.
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
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE (00592).
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
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());

CREATE TABLE public.corporate_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
GRANT SELECT ON public.corporate_employees TO anon, authenticated, service_role;

-- LIVE corporate_accounts: every column, constraint, trigger and policy.
CREATE TABLE public.corporate_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_phone text NOT NULL,
  contact_email text,
  tax_id text,
  status text NOT NULL DEFAULT 'pending'::text,
  created_by uuid NOT NULL,
  monthly_budget_trc integer NOT NULL DEFAULT 0,
  per_ride_cap_trc integer NOT NULL DEFAULT 0,
  allowed_service_types text[] DEFAULT '{}'::text[],
  allowed_hours_start time without time zone,
  allowed_hours_end time without time zone,
  current_month_spent integer NOT NULL DEFAULT 0,
  approved_at timestamp with time zone,
  suspended_at timestamp with time zone,
  suspended_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  commission_percent numeric(5,2) DEFAULT NULL::numeric,
  is_fleet_owner boolean NOT NULL DEFAULT false,
  CONSTRAINT corporate_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT corporate_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT corporate_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text])))
);
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_accounts TO anon, authenticated, service_role;

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

CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_accounts_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_accounts_corp_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM corporate_employees
  WHERE ((corporate_employees.corporate_account_id = corporate_accounts.id) AND (corporate_employees.user_id = auth.uid()) AND (corporate_employees.role = 'admin'::text) AND (corporate_employees.is_active = true)))));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING ((created_by = auth.uid()));
CREATE POLICY corporate_accounts_employee_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM corporate_employees
  WHERE ((corporate_employees.corporate_account_id = corporate_accounts.id) AND (corporate_employees.user_id = auth.uid()) AND (corporate_employees.is_active = true)))));
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK ((created_by = auth.uid()));

-- LIVE driver_fleets: one fleet per corporate account.
CREATE TABLE public.driver_fleets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  corporate_account_id uuid NOT NULL,
  name text NOT NULL,
  vehicle_count_estimate integer,
  vehicle_types text[] DEFAULT '{}'::text[],
  operating_zones text[] DEFAULT '{}'::text[],
  estimated_rides_per_day_per_vehicle integer,
  operating_hours_start time without time zone,
  operating_hours_end time without time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT driver_fleets_pkey PRIMARY KEY (id),
  CONSTRAINT driver_fleets_corporate_account_id_key UNIQUE (corporate_account_id),
  CONSTRAINT driver_fleets_corporate_account_id_fkey FOREIGN KEY (corporate_account_id) REFERENCES corporate_accounts(id) ON DELETE CASCADE
);
ALTER TABLE public.driver_fleets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_fleets TO anon, authenticated, service_role;

CREATE POLICY driver_fleets_admin_delete ON public.driver_fleets FOR DELETE USING (is_admin());
CREATE POLICY driver_fleets_owner_insert ON public.driver_fleets FOR INSERT
  WITH CHECK ((corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid()))));
CREATE POLICY driver_fleets_owner_select ON public.driver_fleets FOR SELECT
  USING ((is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid())))));
CREATE POLICY driver_fleets_owner_update ON public.driver_fleets FOR UPDATE
  USING ((is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid())))));

-- LIVE fleet_members.
CREATE TABLE public.fleet_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL,
  driver_id uuid,
  driver_name text NOT NULL,
  driver_phone text NOT NULL,
  driver_email text,
  driver_license_number text,
  driver_id_number text,
  status text NOT NULL DEFAULT 'pending_review'::text,
  license_doc_path text,
  added_at timestamp with time zone NOT NULL DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  rejected_reason text,
  signed_up_at timestamp with time zone,
  CONSTRAINT fleet_members_pkey PRIMARY KEY (id),
  CONSTRAINT fleet_members_fleet_id_driver_phone_key UNIQUE (fleet_id, driver_phone),
  CONSTRAINT fleet_members_fleet_id_fkey FOREIGN KEY (fleet_id) REFERENCES driver_fleets(id) ON DELETE CASCADE,
  CONSTRAINT fleet_members_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_members_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id),
  CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'pending_signup'::text, 'active'::text, 'inactive'::text])))
);
CREATE INDEX fleet_members_phone_idx ON public.fleet_members USING btree (driver_phone);
CREATE INDEX fleet_members_driver_id_idx ON public.fleet_members USING btree (driver_id);
CREATE INDEX fleet_members_status_idx ON public.fleet_members USING btree (status);
ALTER TABLE public.fleet_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fleet_members TO anon, authenticated, service_role;

CREATE POLICY fleet_members_owner_delete ON public.fleet_members FOR DELETE
  USING ((is_admin() OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid())))));
CREATE POLICY fleet_members_owner_insert ON public.fleet_members FOR INSERT
  WITH CHECK ((fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_or_admin_update ON public.fleet_members FOR UPDATE
  USING ((is_admin() OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid())))));
CREATE POLICY fleet_members_owner_or_self_select ON public.fleet_members FOR SELECT
  USING ((is_admin() OR (driver_id = auth.uid()) OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid())))));

-- LIVE (00600, applied in prod on 2026-09-27): the owner may edit an invitation
-- while it is pending_review; once reviewed, the reviewed columns and fleet_id stay.
CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    -- 00600: the rejection reason is the admin's text. Once the admin has
    -- reviewed the invitation, what they reviewed and the fleet it is for
    -- stay as reviewed; to change them, the owner deletes it and invites again.
    NEW.rejected_reason := OLD.rejected_reason;
    IF OLD.status IS DISTINCT FROM 'pending_review' THEN
      NEW.fleet_id              := OLD.fleet_id;
      NEW.driver_name           := OLD.driver_name;
      NEW.driver_phone          := OLD.driver_phone;
      NEW.driver_email          := OLD.driver_email;
      NEW.driver_license_number := OLD.driver_license_number;
      NEW.driver_id_number      := OLD.driver_id_number;
      NEW.license_doc_path      := OLD.license_doc_path;
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();

-- The people: the fleet owner (a driver) and an admin, as in prod.
INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002');
INSERT INTO public.users (id, phone, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', '+5355550001', 'driver'),
  ('a0000000-0000-4000-8000-000000000002', '+5355550002', 'admin');
