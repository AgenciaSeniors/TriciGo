-- Scaffold for the 00676 rehearsal (fleet invitations and notices): the fleet tables with the keys,
-- grants and EVERY policy read from prod on 2026-11-06, the triggers that write them, and the LIVE
-- bodies of every function those paths run. run.sh compares each body with the md5 and length read
-- from prod (S0). Prod had 0 corporate accounts, fleets and invitations that day.
-- What is not prod: net.http_post records what it would send, in a table, so a rollback cancels it
-- as pg_net's queue does, and it raises while test.http_fail is set to a piece of the URL;
-- vault.decrypted_secrets is a plain table. auth.users and public.users keep only the columns these
-- paths read. No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- A NON-superuser role named postgres owns everything, as in prod, and run.sh applies the migration
-- as that role. New tables are open to the API roles, as pg_default_acl still gives them in prod, and
-- new functions too (prod gives those to service_role only): the migration has to close them itself.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO CURRENT_USER;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA net AUTHORIZATION postgres;
CREATE SCHEMA vault AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ── Stand-ins for pg_net and the vault ───────────────────────
CREATE TABLE net.http_request_queue (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds integer DEFAULT 5000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'net', 'pg_catalog'
AS $function$
DECLARE
  v_fail text := NULLIF(current_setting('test.http_fail', true), '');
  v_id   bigint;
BEGIN
  IF v_fail IS NOT NULL AND position(v_fail IN url) > 0 THEN
    RAISE EXCEPTION 'test: the call to % failed', url;
  END IF;
  INSERT INTO net.http_request_queue (url, headers, body) VALUES (url, headers, body) RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

CREATE TABLE vault.decrypted_secrets (name text PRIMARY KEY, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('service_role_key', 'test-service-key');

-- ── auth ─────────────────────────────────────────────────────
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
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

-- GoTrue's table, trimmed. GoTrue stores phones as E.164 digits without '+'. No grant to the API roles.
CREATE TABLE auth.users (
  id                 uuid PRIMARY KEY,
  email              character varying,
  phone              text DEFAULT NULL,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);

-- ── Tables ───────────────────────────────────────────────────
CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing', 'operator');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TABLE public.users (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone      text,
  full_name  text NOT NULL DEFAULT ''::text,
  email      text,
  role       public.user_role NOT NULL DEFAULT 'customer',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_not_blank CHECK (((phone IS NULL) OR (btrim(phone) <> ''::text)))
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users FROM anon, authenticated;
GRANT SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.users TO anon, authenticated;

CREATE TABLE public.driver_profiles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status  public.driver_status NOT NULL DEFAULT 'pending_verification'
);

CREATE TABLE public.notification_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  driver_approval boolean NOT NULL DEFAULT true
);

CREATE TABLE public.admin_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid REFERENCES public.users(id),
  action      text,
  target_type text,
  target_id   text,
  old_values  jsonb,
  new_values  jsonb,
  reason      text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE public.rpc_attempt_log (
  id         bigserial PRIMARY KEY,
  rpc_name   text NOT NULL,
  caller_uid uuid,
  target_id  uuid,
  outcome    text NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname    text NOT NULL,
  url        text,
  called_at  timestamptz NOT NULL DEFAULT now()
);

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
  CONSTRAINT corporate_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id),
  CONSTRAINT corporate_accounts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'suspended'::text, 'rejected'::text]))),
  CONSTRAINT corporate_accounts_monthly_budget_nonneg CHECK ((monthly_budget_trc >= 0)),
  CONSTRAINT corporate_accounts_per_ride_cap_nonneg CHECK ((per_ride_cap_trc >= 0))
);
ALTER TABLE public.corporate_accounts ENABLE ROW LEVEL SECURITY;

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
ALTER TABLE public.corporate_employees ENABLE ROW LEVEL SECURITY;

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
  city text,
  CONSTRAINT driver_fleets_pkey PRIMARY KEY (id),
  CONSTRAINT driver_fleets_corporate_account_id_key UNIQUE (corporate_account_id),
  CONSTRAINT driver_fleets_corporate_account_id_fkey FOREIGN KEY (corporate_account_id) REFERENCES public.corporate_accounts(id) ON DELETE CASCADE,
  CONSTRAINT driver_fleets_city_length CHECK (((city IS NULL) OR ((char_length(city) >= 1) AND (char_length(city) <= 120))))
);
ALTER TABLE public.driver_fleets ENABLE ROW LEVEL SECURITY;

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
  CONSTRAINT fleet_members_fleet_id_fkey FOREIGN KEY (fleet_id) REFERENCES public.driver_fleets(id) ON DELETE CASCADE,
  CONSTRAINT fleet_members_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT fleet_members_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id),
  CONSTRAINT fleet_members_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text, 'pending_signup'::text, 'active'::text, 'inactive'::text])))
);
CREATE INDEX fleet_members_phone_idx ON public.fleet_members USING btree (driver_phone);
CREATE INDEX fleet_members_driver_id_idx ON public.fleet_members USING btree (driver_id);
CREATE INDEX fleet_members_status_idx ON public.fleet_members USING btree (status);
ALTER TABLE public.fleet_members ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.corporate_accounts, public.corporate_employees, public.driver_fleets, public.fleet_members
  TO anon, authenticated, service_role;
GRANT ALL ON public.users TO service_role;

-- ── Role checks ──────────────────────────────────────────────
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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.is_ops_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Admins, super admins and operators (00668). No JWT subject: false, with the early return of
  -- is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin', 'operator');
END;
$function$;

CREATE OR REPLACE FUNCTION public._ops_allow(p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_cur text := COALESCE(pg_catalog.current_setting('app.ops_targets', true), '');
BEGIN
  PERFORM pg_catalog.set_config('app.ops_targets',
    pg_catalog.concat_ws(',', NULLIF(v_cur, ''), pg_catalog.array_to_string(p_ids, ',')), true);
END
$function$;
REVOKE ALL ON FUNCTION public._ops_allow(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._ops_acting_on(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_targets text := COALESCE(pg_catalog.current_setting('app.ops_targets', true), '');
BEGIN
  -- The setting first: without it nobody acts on anything, and is_ops_staff() is not asked.
  IF p_id IS NULL OR v_targets = '' THEN
    RETURN false;
  END IF;
  RETURN p_id::text = ANY (pg_catalog.string_to_array(v_targets, ',')) AND public.is_ops_staff();
END
$function$;
REVOKE ALL ON FUNCTION public._ops_acting_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._ops_acting_on(uuid) TO anon, authenticated, service_role;

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
REVOKE ALL ON FUNCTION public.is_corp_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_corp_admin(uuid) TO authenticated, service_role;

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

-- ── Helpers the notices run ──────────────────────────────────
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

CREATE OR REPLACE FUNCTION public._third_party_person_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH w AS (
    SELECT t.word, row_number() OVER (ORDER BY t.ord) AS n
    FROM (
      SELECT regexp_replace(s.word, '[^A-Za-zÀ-ÖØ-öø-ÿ''-]', '', 'g') AS word, s.ord
      FROM regexp_split_to_table(coalesce(p_name, ''), '\s+') WITH ORDINALITY AS s(word, ord)
    ) t
    WHERE t.word ~ '[A-Za-zÀ-ÖØ-öø-ÿ]'
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM w WHERE n = 2) THEN (SELECT left(word, 20) FROM w WHERE n = 1)
    ELSE (SELECT left(word, 20) FROM w WHERE n = 1) || ' ' || (SELECT upper(left(word, 1)) FROM w WHERE n = 2) || '.'
  END;
$function$;
REVOKE ALL ON FUNCTION public._third_party_person_name(text) FROM PUBLIC, anon, authenticated, service_role;

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
REVOKE ALL ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;
  RETURN v_key;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._ops_user_push(p_rpc text, p_target uuid, p_user_id uuid,
                                                 p_title text, p_body text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.notification_preferences np
             WHERE np.user_id = p_user_id AND np.driver_approval IS FALSE) THEN
    RETURN;
  END IF;
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
        jsonb_build_object('user_id', p_user_id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('ops-driver-review',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object('user_ids', jsonb_build_array(p_user_id::text), 'title', p_title,
                                      'body', p_body, 'data', COALESCE(p_data, '{}'::jsonb)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_target, 'push_failed',
      jsonb_build_object('user_id', p_user_id, 'error', SQLERRM));
  END;
END
$function$;
REVOKE ALL ON FUNCTION public._ops_user_push(text, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._user_id_by_verified_phone(p_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_norm text := public._normalize_cuban_phone(p_phone);
  v_id   uuid;
BEGIN
  IF v_norm IS NULL OR v_norm !~ '^\+[0-9]{8,15}$' THEN
    RETURN NULL;
  END IF;

  -- GoTrue stores E.164 without '+'; both spellings use users_phone_key.
  -- Anything but exactly one match returns NULL: never guess.
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END
    INTO v_id
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone IN (v_norm, substr(v_norm, 2))
    AND au.phone_confirmed_at IS NOT NULL
    AND u.is_active;

  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;

-- ── Triggers already on these tables ─────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_driver_fleets_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00672: ops staff inside ops_review_fleet_account, on this fleet's account.
  IF is_admin() OR public._ops_acting_on(NEW.id) THEN
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

  -- 00625: monthly_budget_trc and per_ride_cap_trc are the company's to set
  -- (RLS lets only its active admins update the row).
  NEW.status              := OLD.status;
  NEW.commission_percent  := OLD.commission_percent;
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
$function$;

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

CREATE OR REPLACE FUNCTION public.tg_corporate_employees_protect_creator()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.is_admin()
     AND EXISTS (SELECT 1 FROM corporate_accounts
                 WHERE id = OLD.corporate_account_id AND created_by = OLD.user_id)
     AND (TG_OP = 'DELETE'
          OR NOT NEW.is_active
          OR NEW.role <> 'admin'
          OR NEW.user_id <> OLD.user_id
          OR NEW.corporate_account_id <> OLD.corporate_account_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Quien creó la empresa no se puede quitar ni cambiar de rol: los viajes se pagan con su billetera.',
      DETAIL = 'corporate_creator_protected';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_fleets_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  -- 00609: a fleet stays with the company it was created for, and so do the
  -- drivers that point at its id.
  NEW.id := OLD.id;
  NEW.corporate_account_id := OLD.corporate_account_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00672: ops staff inside ops_review_fleet_member, on this invitation.
  IF is_admin() OR public._ops_acting_on(NEW.id) THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.tg_fleet_members_set_driver_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_driver uuid;
BEGIN
  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL
     OR NEW.status NOT IN ('approved', 'pending_signup') THEN
    RETURN NEW;
  END IF;
  -- Only when this write makes the invitation linkable. A row that already
  -- was is left alone: a later edit of an approved invitation links nobody.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('approved', 'pending_signup') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_driver := public._user_id_by_verified_phone(NEW.driver_phone);
  IF v_driver IS NOT NULL THEN
    NEW.driver_id    := v_driver;
    NEW.status       := 'active';
    NEW.signed_up_at := COALESCE(NEW.signed_up_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_phone text;
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  -- Runs inside GoTrue's signup transaction: failing to link must never fail
  -- the signup. lock_timeout turns a lock wait into an error caught here.
  BEGIN
    -- Only a number this account confirmed by OTP. GoTrue inserts accounts
    -- before confirming them, so in practice on_auth_user_phone_confirmed
    -- links them; this covers an account inserted already confirmed.
    v_phone := '+' || ltrim(NEW.phone, '+');
    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;

    PERFORM set_config('app.trusted_fleet_update', '1', true);

    UPDATE fleet_members
    SET driver_id = NEW.id,
        status = 'active',
        signed_up_at = now()
    WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(v_phone)
      AND status IN ('approved', 'pending_signup')
      AND driver_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_signup', NULL, NEW.id, 'link_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_phone_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_phone text;
BEGIN
  -- Fires on every update of auth.users. Only a number that just became
  -- confirmed for this account counts: its first confirmation, or a new
  -- number on an account already confirmed.
  IF NEW.phone IS NULL OR NEW.phone = '' OR NEW.phone_confirmed_at IS NULL
     OR NOT (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone) THEN
    RETURN NEW;
  END IF;

  -- Runs inside GoTrue's transaction (link-phone, verify-otp, GoTrue's own
  -- OTP): failing to link must never fail the login or the confirmation.
  -- lock_timeout turns a lock wait into an error caught here. GoTrue's
  -- connection carries no JWT, so tg_fleet_members_protect lets this through.
  BEGIN
    v_phone := '+' || ltrim(NEW.phone, '+');   -- GoTrue keeps E.164 without '+'
    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;

    UPDATE public.fleet_members fm
    SET driver_id = NEW.id,
        status = 'active',
        signed_up_at = COALESCE(fm.signed_up_at, now())
    WHERE public._normalize_cuban_phone(fm.driver_phone) = public._normalize_cuban_phone(v_phone)
      AND fm.status IN ('approved', 'pending_signup')
      AND fm.driver_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_phone_confirmed', NULL, NEW.id, 'link_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;

  RETURN NEW;
END;
$function$;

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

-- ── The panel's review functions (00672) ─────────────────────
CREATE OR REPLACE FUNCTION public.ops_review_fleet_account(p_account_id uuid, p_decision text,
                                                           p_expected_status text, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ca     public.corporate_accounts%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('error', 'invalid_decision');
  END IF;
  IF p_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ca FROM public.corporate_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'account_not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_fleets df WHERE df.corporate_account_id = v_ca.id) THEN
    RETURN jsonb_build_object('error', 'not_a_fleet');
  END IF;
  IF v_ca.created_by = v_me OR EXISTS (
       SELECT 1 FROM public.corporate_employees ce
       WHERE ce.corporate_account_id = v_ca.id AND ce.user_id = v_me AND ce.is_active) THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;
  IF v_ca.status::text IS DISTINCT FROM p_expected_status THEN
    RETURN jsonb_build_object('error', 'account_changed', 'status', v_ca.status);
  END IF;
  IF v_ca.status::text <> 'pending' THEN
    RETURN jsonb_build_object('error', 'invalid_transition', 'status', v_ca.status);
  END IF;

  PERFORM public._ops_allow(ARRAY[v_ca.id]);
  IF p_decision = 'approved' THEN
    UPDATE public.corporate_accounts SET status = 'approved', approved_at = now(), is_fleet_owner = true
     WHERE id = v_ca.id;
  ELSE
    UPDATE public.corporate_accounts SET status = 'rejected', suspended_reason = v_reason WHERE id = v_ca.id;
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_me, CASE WHEN p_decision = 'approved' THEN 'approve_corporate' ELSE 'reject_corporate' END,
          'corporate_account', v_ca.id::text,
          jsonb_build_object('status', v_ca.status), jsonb_build_object('status', p_decision, 'fleet', true),
          v_reason);

  RETURN jsonb_build_object('success', true, 'status', p_decision);
END
$function$;

CREATE OR REPLACE FUNCTION public.ops_review_fleet_member(p_member_id uuid, p_decision text,
                                                          p_shown jsonb, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_me     uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_owner  uuid;
  v_n      integer;
  v_status text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('error', 'invalid_decision');
  END IF;
  IF p_decision = 'rejected' AND (v_reason IS NULL OR length(v_reason) < 3) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_shown IS NULL OR jsonb_typeof(p_shown) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_shown');
  END IF;

  SELECT ca.created_by INTO v_owner
  FROM public.fleet_members fm
  JOIN public.driver_fleets df ON df.id = fm.fleet_id
  JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id
  WHERE fm.id = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'member_not_found');
  END IF;
  IF v_owner = v_me THEN
    RETURN jsonb_build_object('error', 'self_action');
  END IF;

  PERFORM public._ops_allow(ARRAY[p_member_id]);
  UPDATE public.fleet_members fm
     SET status = p_decision, reviewed_by = v_me, reviewed_at = now(),
         rejected_reason = CASE WHEN p_decision = 'rejected' THEN v_reason ELSE fm.rejected_reason END
   WHERE fm.id = p_member_id
     AND fm.status = 'pending_review'
     AND fm.fleet_id::text IS NOT DISTINCT FROM (p_shown ->> 'fleet_id')
     AND fm.driver_name IS NOT DISTINCT FROM (p_shown ->> 'driver_name')
     AND fm.driver_phone IS NOT DISTINCT FROM (p_shown ->> 'driver_phone')
     AND fm.driver_email IS NOT DISTINCT FROM (p_shown ->> 'driver_email')
     AND fm.driver_license_number IS NOT DISTINCT FROM (p_shown ->> 'driver_license_number')
     AND fm.driver_id_number IS NOT DISTINCT FROM (p_shown ->> 'driver_id_number')
     AND fm.license_doc_path IS NOT DISTINCT FROM (p_shown ->> 'license_doc_path');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('error', 'member_changed');
  END IF;
  SELECT status INTO v_status FROM public.fleet_members WHERE id = p_member_id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values, reason)
  VALUES (v_me, CASE WHEN p_decision = 'approved' THEN 'approve_fleet_member' ELSE 'reject_fleet_member' END,
          'fleet_member', p_member_id::text, jsonb_build_object('status', v_status), v_reason);

  RETURN jsonb_build_object('success', true, 'status', v_status);
END
$function$;
REVOKE ALL ON FUNCTION public.ops_review_fleet_account(uuid, text, text, text),
                       public.ops_review_fleet_member(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_review_fleet_account(uuid, text, text, text),
                          public.ops_review_fleet_member(uuid, text, jsonb, text) TO authenticated, service_role;

-- ── Policies (pg_policies, 2026-11-06) ───────────────────────
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_marketing ON public.users FOR SELECT TO authenticated USING (( SELECT is_marketing() AS is_marketing));
CREATE POLICY users_select_operator ON public.users FOR SELECT TO authenticated USING (( SELECT is_operator() AS is_operator));
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = ( SELECT auth.uid() AS uid));

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
  USING (is_corp_admin(corporate_account_id) OR ( SELECT is_admin() AS is_admin));
CREATE POLICY corporate_employees_corp_admin_insert ON public.corporate_employees FOR INSERT TO authenticated
  WITH CHECK (is_corp_admin(corporate_account_id) OR is_admin());
CREATE POLICY corporate_employees_corp_admin_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (is_corp_admin(corporate_account_id) OR (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = auth.uid()) AND (users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))));
CREATE POLICY corporate_employees_corp_admin_update ON public.corporate_employees FOR UPDATE TO authenticated
  USING (is_corp_admin(corporate_account_id) OR ( SELECT is_admin() AS is_admin))
  WITH CHECK (is_corp_admin(corporate_account_id) OR ( SELECT is_admin() AS is_admin));
CREATE POLICY corporate_employees_select_operator ON public.corporate_employees FOR SELECT TO authenticated
  USING (( SELECT is_operator() AS is_operator));
CREATE POLICY corporate_employees_self_read ON public.corporate_employees FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY driver_fleets_admin_delete ON public.driver_fleets FOR DELETE USING (is_admin());
CREATE POLICY driver_fleets_owner_insert ON public.driver_fleets FOR INSERT
  WITH CHECK (corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid())));
CREATE POLICY driver_fleets_owner_select ON public.driver_fleets FOR SELECT
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid()))));
CREATE POLICY driver_fleets_owner_update ON public.driver_fleets FOR UPDATE
  USING (is_admin() OR (corporate_account_id IN ( SELECT corporate_accounts.id
   FROM corporate_accounts
  WHERE (corporate_accounts.created_by = auth.uid()))));
CREATE POLICY driver_fleets_select_operator ON public.driver_fleets FOR SELECT TO authenticated
  USING (( SELECT is_operator() AS is_operator));

CREATE POLICY fleet_members_owner_delete ON public.fleet_members FOR DELETE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_insert ON public.fleet_members FOR INSERT
  WITH CHECK (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid())));
CREATE POLICY fleet_members_owner_or_admin_update ON public.fleet_members FOR UPDATE
  USING (is_admin() OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_owner_or_self_select ON public.fleet_members FOR SELECT
  USING (is_admin() OR (driver_id = auth.uid()) OR (fleet_id IN ( SELECT df.id
   FROM (driver_fleets df
     JOIN corporate_accounts ca ON ((ca.id = df.corporate_account_id)))
  WHERE (ca.created_by = auth.uid()))));
CREATE POLICY fleet_members_select_operator ON public.fleet_members FOR SELECT TO authenticated
  USING (( SELECT is_operator() AS is_operator));

-- ── Seed ─────────────────────────────────────────────────────
-- Ana owns a fleet still pending (cap / dfp) and a corporate client with no fleet (cac). Beto owns an
-- approved fleet (caa / dfa). Olga is an operator and Eva an admin. Pepe is a passenger, Dora an
-- approved driver, Rafa a driver still in review, and Xavi an approved driver with a number from
-- outside Cuba: the four confirmed their numbers. Nico has nothing to do with any fleet.
-- Nobody holds the numbers 5355520001 and 5355530001. Every member is pending_review.
INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('a6760000-0000-4000-8000-000000000001', '5355590001', now()),
  ('a6760000-0000-4000-8000-000000000002', '5355590002', now()),
  ('a6760000-0000-4000-8000-000000000003', '5355590003', now()),
  ('a6760000-0000-4000-8000-000000000004', '5355590004', now()),
  ('a6760000-0000-4000-8000-000000000005', '5355510005', now()),
  ('a6760000-0000-4000-8000-000000000006', '5355510006', now()),
  ('a6760000-0000-4000-8000-000000000007', '5355510007', now()),
  ('a6760000-0000-4000-8000-000000000008', '5355590008', now()),
  ('a6760000-0000-4000-8000-000000000009', '13055550100', now());
INSERT INTO public.users (id, phone, full_name, role) VALUES
  ('a6760000-0000-4000-8000-000000000001', '+5355590001', 'Ana María Pérez', 'customer'),
  ('a6760000-0000-4000-8000-000000000002', '+5355590002', 'Beto Ruiz', 'customer'),
  ('a6760000-0000-4000-8000-000000000003', '+5355590003', 'Olga Soto', 'operator'),
  ('a6760000-0000-4000-8000-000000000004', '+5355590004', 'Eva Díaz', 'admin'),
  ('a6760000-0000-4000-8000-000000000005', '+5355510005', 'Pepe Luna', 'customer'),
  ('a6760000-0000-4000-8000-000000000006', '+5355510006', 'Dora Vega', 'driver'),
  ('a6760000-0000-4000-8000-000000000007', '+5355510007', 'Rafa Mora', 'customer'),
  ('a6760000-0000-4000-8000-000000000008', '+5355590008', 'Nico Paz', 'customer'),
  ('a6760000-0000-4000-8000-000000000009', '+13055550100', 'Xavi Gil', 'driver');
INSERT INTO public.driver_profiles (user_id, status) VALUES
  ('a6760000-0000-4000-8000-000000000006', 'approved'),
  ('a6760000-0000-4000-8000-000000000007', 'under_review'),
  ('a6760000-0000-4000-8000-000000000009', 'approved');
INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by) VALUES
  ('c6760000-0000-4000-8000-00000000000a', 'EMPRESA-SECRETA', '+5355590001', 'pending', 'a6760000-0000-4000-8000-000000000001'),
  ('c6760000-0000-4000-8000-00000000000b', 'Beto Transporte', '+5355590002', 'approved', 'a6760000-0000-4000-8000-000000000002'),
  ('c6760000-0000-4000-8000-00000000000c', 'Cliente sin flota', '+5355590001', 'pending', 'a6760000-0000-4000-8000-000000000001');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES
  ('d6760000-0000-4000-8000-00000000000a', 'c6760000-0000-4000-8000-00000000000a', 'FLOTA-SECRETA'),
  ('d6760000-0000-4000-8000-00000000000b', 'c6760000-0000-4000-8000-00000000000b', 'Flota Beto');
INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, added_at) VALUES
  ('f6760000-0000-4000-8000-0000000000a1', 'd6760000-0000-4000-8000-00000000000a', 'Pablo Uno', '+5355520001', now() - interval '9 minutes'),
  ('f6760000-0000-4000-8000-0000000000a2', 'd6760000-0000-4000-8000-00000000000a', 'Pepe Luna', '+5355510005', now() - interval '8 minutes'),
  ('f6760000-0000-4000-8000-0000000000a3', 'd6760000-0000-4000-8000-00000000000a', 'Dora Vega', '+5355510006', now() - interval '7 minutes'),
  ('f6760000-0000-4000-8000-0000000000b1', 'd6760000-0000-4000-8000-00000000000b', 'Quique Uno', '+5355530001', now() - interval '9 minutes'),
  ('f6760000-0000-4000-8000-0000000000b2', 'd6760000-0000-4000-8000-00000000000b', 'Pepe Luna', '+5355510005', now() - interval '8 minutes'),
  ('f6760000-0000-4000-8000-0000000000b3', 'd6760000-0000-4000-8000-00000000000b', 'Dora Vega', '55510006', now() - interval '7 minutes'),
  ('f6760000-0000-4000-8000-0000000000b4', 'd6760000-0000-4000-8000-00000000000b', 'Rafa Mora', '+5355510007', now() - interval '6 minutes'),
  ('f6760000-0000-4000-8000-0000000000b5', 'd6760000-0000-4000-8000-00000000000b', 'Xavi Gil', '+13055550100', now() - interval '5 minutes'),
  ('f6760000-0000-4000-8000-0000000000b6', 'd6760000-0000-4000-8000-00000000000b', 'Yoli Fuera', '+13055550199', now() - interval '4 minutes'),
  ('f6760000-0000-4000-8000-0000000000b7', 'd6760000-0000-4000-8000-00000000000b', 'Zoe Fijo', '+5378612345', now() - interval '3 minutes'),
  ('f6760000-0000-4000-8000-0000000000b8', 'd6760000-0000-4000-8000-00000000000b', 'Gemela Una', '55530008', now() - interval '2 minutes'),
  ('f6760000-0000-4000-8000-0000000000b9', 'd6760000-0000-4000-8000-00000000000b', 'Gemela Dos', '+5355530008', now() - interval '1 minute');

-- ── Triggers, after the seed (pg_get_triggerdef, 2026-11-06) ─
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER on_auth_user_phone_confirmed AFTER UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_confirmed();
CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();
CREATE TRIGGER set_corporate_accounts_updated_at BEFORE UPDATE ON public.corporate_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_corporate_accounts_protect_admin_fields BEFORE UPDATE ON public.corporate_accounts FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_accounts_protect_admin_fields();
CREATE TRIGGER trg_corporate_accounts_protect_insert BEFORE INSERT ON public.corporate_accounts FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_accounts_protect_insert();
CREATE TRIGGER trg_corporate_employees_protect_creator BEFORE UPDATE OR DELETE ON public.corporate_employees FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_employees_protect_creator();
CREATE TRIGGER driver_fleets_updated_at BEFORE UPDATE ON public.driver_fleets FOR EACH ROW EXECUTE FUNCTION public.trg_driver_fleets_updated_at();
CREATE TRIGGER trg_driver_fleets_protect BEFORE UPDATE ON public.driver_fleets FOR EACH ROW EXECUTE FUNCTION public.tg_driver_fleets_protect();
CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_protect();
CREATE TRIGGER trg_fleet_members_set_driver_on_approval BEFORE INSERT OR UPDATE OF status ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_set_driver_on_approval();

RESET ROLE;
