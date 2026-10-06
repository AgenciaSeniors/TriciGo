-- Scaffold for the 00595 rehearsal: the LIVE production shapes of users,
-- corporate_accounts, driver_fleets and fleet_members, and the functions the
-- signup path runs, transcribed on 2026-09-25 from pg_constraint, pg_indexes,
-- pg_trigger and pg_get_functiondef. The bodies of
-- auto_link_fleet_member_on_signup() (md5(prosrc) 0b74fd48e33257ba39bd719376d1a732,
-- length 494, identical to 00461), tg_fleet_members_protect(),
-- tg_corporate_accounts_protect_insert() and _normalize_cuban_phone() are byte
-- for byte the ones running in prod. Only the columns the signup path touches
-- are kept on public.users. All four tables had 0 rows in prod except users.
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

-- Stub for the live is_admin() (00592): false without a JWT, and nobody in this
-- rehearsal is an admin unless a test sets test.is_admin.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth.uid() IS NOT NULL AND coalesce(current_setting('test.is_admin', true), '') = 'true'
$$;

CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- LIVE public.users, trimmed to the columns this path reads.
CREATE TABLE public.users (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- LIVE (00461).
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

-- LIVE corporate_accounts: every column, constraint and trigger.
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

-- LIVE fleet_members: unique only on (fleet_id, driver_phone) as typed; nothing
-- limits a driver to one fleet.
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

-- LIVE (pre-00595): the RETURNING ... INTO raises TOO_MANY_ROWS as soon as the
-- UPDATE matches 2+ invitations, which aborts the INSERT into public.users.
-- ACL {postgres=X, service_role=X}.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member_id uuid;
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
    AND driver_id IS NULL
  RETURNING id INTO v_member_id;

  RETURN NEW;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;
CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup();

-- Existing people, as in prod (the migration's self-test borrows the oldest).
INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002');
INSERT INTO public.users (id, phone, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000001', '+5355550001', '2026-03-01 12:00:00+00'),
  ('a0000000-0000-4000-8000-000000000002', NULL,          '2026-03-02 12:00:00+00');
