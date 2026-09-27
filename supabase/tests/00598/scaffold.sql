-- Scaffold for the 00598 rehearsal: the LIVE production shapes of users,
-- corporate_accounts, driver_fleets and fleet_members, their RLS policies and
-- grants, and every function the fleet-linking paths run, transcribed on
-- 2026-09-25 from pg_get_functiondef, pg_policies, pg_trigger, pg_indexes and
-- information_schema. Each function body is byte for byte the one running in
-- prod: run.sh checks md5(prosrc) and length against the values read there.
-- auth.users keeps only the columns _user_id_by_verified_phone reads, with
-- GoTrue's unique index on phone; public.users keeps the columns these paths
-- and tg_users_protect_admin_fields touch. RLS is on, so the tests run each
-- call as `authenticated` with a JWT subject, the way PostgREST does.
-- fleet_members, driver_fleets and corporate_accounts had 0 rows in prod.
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

-- GoTrue's table, trimmed to what handle_new_user and the linking paths read.
-- GoTrue stores phones as E.164 digits without '+' (all 544 in prod are
-- 53XXXXXXXX). No grant to anon/authenticated, as in prod.
CREATE TABLE auth.users (
  id                 uuid PRIMARY KEY,
  email              character varying,
  phone              text DEFAULT NULL,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);

-- LIVE public.users, trimmed. No unique index on phone: prod has none.
CREATE TABLE public.users (
  id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone                text,
  full_name            text NOT NULL DEFAULT ''::text,
  email                text,
  role                 public.user_role NOT NULL DEFAULT 'customer',
  is_active            boolean NOT NULL DEFAULT true,
  level                text NOT NULL DEFAULT 'bronce',
  total_rides          integer NOT NULL DEFAULT 0,
  total_spent          numeric NOT NULL DEFAULT 0,
  cancellation_count   integer NOT NULL DEFAULT 0,
  last_cancellation_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- As in prod: authenticated may UPDATE every column of its own row, phone included.
GRANT SELECT, INSERT, UPDATE ON public.users TO anon, authenticated, service_role;

-- LIVE driver_profiles, trimmed: tg_users_protect_admin_fields reads it.
CREATE TABLE public.driver_profiles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status  text NOT NULL DEFAULT 'pending_verification'
);

-- LIVE (md5 cb4a7c12…, 103)
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
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE (00592, md5 22cb75e9…, 285)
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

-- LIVE (md5 5655a461…, 105)
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

-- LIVE (00487, md5 9f5227a3…, 451)
CREATE OR REPLACE FUNCTION public._normalize_cuban_phone(p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_digits text;
BEGIN
  IF p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := regexp_replace(p_phone, '\D', '', 'g');
  -- Bare local mobile: 8 digits starting with 5 (legacy) or 6 (new 63/64)
  IF v_digits ~ '^[56]\d{7}$' THEN
    RETURN '+53' || v_digits;
  -- With country code, no +: 53 followed by the 8-digit subscriber number
  ELSIF v_digits ~ '^53\d{8}$' THEN
    RETURN '+' || v_digits;
  END IF;
  RETURN p_phone;
END;
$function$;

-- LIVE (00461, md5 c0491b42…, 147)
CREATE OR REPLACE FUNCTION public.tg_users_normalize_phone()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    NEW.phone := public._normalize_cuban_phone(NEW.phone);
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_normalize_phone();

-- LIVE (md5 2907fccb…, 1701): reverts role/is_active/level/counters for a
-- non-admin, but NOT phone.
CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_tier_update', true) = '1' THEN
    NEW.role                 := OLD.role;
    NEW.is_active            := OLD.is_active;
    NEW.total_spent          := OLD.total_spent;
    NEW.cancellation_count   := OLD.cancellation_count;
    NEW.last_cancellation_at := OLD.last_cancellation_at;
    NEW.id                   := OLD.id;
    NEW.created_at           := OLD.created_at;
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_cancel_update', true) = '1' THEN
    NEW.role        := OLD.role;
    NEW.is_active   := OLD.is_active;
    NEW.level       := OLD.level;
    NEW.total_rides := OLD.total_rides;
    NEW.total_spent := OLD.total_spent;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF is_admin() THEN
    IF NOT (OLD.role = 'customer' AND NEW.role = 'driver'
            AND EXISTS (SELECT 1 FROM driver_profiles dp
                        WHERE dp.user_id = NEW.id AND dp.status = 'approved')) THEN
      NEW.role := OLD.role;
    END IF;
    NEW.level := OLD.level;
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() TO service_role;
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_protect_admin_fields();

-- LIVE (md5 c42fa89f…, 299): GoTrue's INSERT into auth.users creates the
-- public.users row, copying the auth phone whether or not it is confirmed.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.users (id, phone, full_name, email, role)
  VALUES (
    NEW.id,
    NULLIF(NEW.phone, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE WHEN NEW.email ~* '^phone_\d+@tricigo\.app$' THEN NULL ELSE NEW.email END,
    'customer'
  );
  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- LIVE rpc_attempt_log and log_rpc_attempt (md5 0a902c34…, 203): the forensic log
-- the linking functions write to when they swallow a failure.
CREATE TABLE public.rpc_attempt_log (
  id         bigserial PRIMARY KEY,
  rpc_name   text NOT NULL,
  caller_uid uuid,
  target_id  uuid,
  outcome    text NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) TO service_role;

-- LIVE users policies
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK (id = ( SELECT auth.uid() AS uid));
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = ( SELECT auth.uid() AS uid));

-- LIVE corporate_accounts: every column and constraint.
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
ALTER TABLE public.corporate_accounts ADD CONSTRAINT corporate_accounts_commission_range
  CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))) NOT VALID;
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;

-- LIVE (00434, md5 16d3e412…, 455)
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

-- LIVE corporate_accounts policies (corporate_accounts_corp_admin_update needs
-- corporate_employees and no test updates corporate_accounts, so it is left out).
CREATE POLICY corporate_accounts_admin_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_admin_update ON public.corporate_accounts FOR UPDATE TO authenticated
  USING (EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))));
CREATE POLICY corporate_accounts_creator_read ON public.corporate_accounts FOR SELECT TO authenticated
  USING (created_by = auth.uid());
CREATE POLICY corporate_accounts_insert ON public.corporate_accounts FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

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
CREATE POLICY driver_fleets_admin_delete ON public.driver_fleets FOR DELETE USING (is_admin());
CREATE POLICY driver_fleets_owner_insert ON public.driver_fleets FOR INSERT
  WITH CHECK (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid())));
CREATE POLICY driver_fleets_owner_select ON public.driver_fleets FOR SELECT
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid()))));
CREATE POLICY driver_fleets_owner_update ON public.driver_fleets FOR UPDATE
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id FROM corporate_accounts WHERE (corporate_accounts.created_by = auth.uid()))));

-- LIVE fleet_members: unique only on (fleet_id, driver_phone) as typed.
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
CREATE POLICY fleet_members_owner_delete ON public.fleet_members FOR DELETE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_insert ON public.fleet_members FOR INSERT
  WITH CHECK (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid())));
CREATE POLICY fleet_members_owner_or_admin_update ON public.fleet_members FOR UPDATE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_or_self_select ON public.fleet_members FOR SELECT
  USING (is_admin() OR (driver_id = auth.uid()) OR (fleet_id IN ( SELECT df.id FROM (driver_fleets df JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id))) WHERE (ca.created_by = auth.uid()))));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.corporate_accounts, public.driver_fleets, public.fleet_members TO anon, authenticated, service_role;

-- LIVE (00435, md5 8b0d07af…, 674)
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
    RETURN NEW;
  END IF;
END;
$function$;
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();

-- LIVE (00595, md5 c4b25ab7…, 434). ACL {postgres=X, service_role=X}.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;
CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup();

-- LIVE (00461, md5 87327e7e…, 565). ACL {postgres=X, service_role=X, authenticated=X}.
CREATE OR REPLACE FUNCTION public.relink_fleet_member_for_existing_driver(p_driver_id uuid, p_phone text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: only admins can relink fleet members';
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = p_driver_id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(p_phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.relink_fleet_member_for_existing_driver(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.relink_fleet_member_for_existing_driver(uuid, text) TO authenticated, service_role;
