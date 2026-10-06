-- Scaffold for the 00605 rehearsal: the LIVE production shapes an INSERT into
-- public.users goes through, transcribed from pg_get_functiondef, pg_policies,
-- pg_trigger and pg_class.relacl on 2026-09-27 (00599 already applied).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST sets it.
--
-- Not modelled: two more AFTER INSERT triggers on public.users in prod,
-- audit_users (record_audit) and auto_link_fleet_member_on_signup (links only
-- the account's confirmed phone since 00598). A refused INSERT never reaches
-- them and they are unchanged, so do not reuse this scaffold as complete.
--
-- Ownership mirrors prod: tables and functions belong to a role that is NOT a
-- superuser (prod: postgres), which is a member of the client roles (so it can
-- SET ROLE authenticated, like prod's postgres), and run.sh applies the
-- migration as that role. A superuser owner would bypass RLS even when forced,
-- hiding the regression that matters most here: without an INSERT policy,
-- sign-up only works because handle_new_user's owner owns public.users and
-- RLS on it is not forced.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, supabase_auth_admin, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, supabase_auth_admin;

-- LIVE auth.uid()
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
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role, supabase_auth_admin;

-- auth.users: only the columns that matter here. GoTrue writes it as
-- supabase_auth_admin; clients cannot read it.
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email varchar(255),
  phone text DEFAULT NULL::character varying,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);
GRANT ALL ON auth.users TO supabase_auth_admin;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'corporate_cash', 'tricicoin', 'platform_revenue');

-- LIVE public.users columns (city_id's FK to cities left out: not involved)
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone text,
  email text,
  full_name text NOT NULL DEFAULT ''::text,
  role public.user_role NOT NULL DEFAULT 'customer'::public.user_role,
  avatar_url text,
  preferred_language text NOT NULL DEFAULT 'es'::text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  level public.user_level NOT NULL DEFAULT 'bronce'::public.user_level,
  total_rides integer NOT NULL DEFAULT 0,
  total_spent integer NOT NULL DEFAULT 0,
  cancellation_count integer DEFAULT 0,
  last_cancellation_at timestamptz,
  sms_notifications_enabled boolean DEFAULT true,
  city_id uuid,
  password_set_at timestamptz,
  email_verified_at timestamptz,
  is_test boolean NOT NULL DEFAULT false,
  CONSTRAINT users_phone_not_blank CHECK (phone IS NULL OR btrim(phone) <> '')
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- LIVE relacl: {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}; no column ACLs
GRANT ALL ON public.users TO anon, authenticated, service_role;

-- Only what the admin branch of the protect trigger reads.
CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL);

-- What the AFTER INSERT wallet trigger writes (unique key as in prod).
CREATE TABLE public.wallet_accounts (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  account_type public.wallet_account_type NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);

-- LIVE: telemetry sink the protect trigger logs to.
CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
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
REVOKE ALL ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) TO service_role;

-- LIVE role helpers
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
REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

-- LIVE phone normalization (00461 + 00487)
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

-- LIVE protect trigger, 00599 body (md5 377912e83023297eda4761622a113364, length 2995).
-- BEFORE UPDATE only: nothing like it runs on INSERT.
CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_verified text;
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- 00599: gifts, diaspora recharges, ride calls and SMS go to users.phone, so
  -- a caller with a JWT that is not an admin may only write the number its
  -- account confirmed by OTP (auth.users.phone with phone_confirmed_at),
  -- stored as E.164. Anything else is put back and logged without the number.
  -- Checked before the trusted branches below, so they cannot open it.
  IF NEW.phone IS DISTINCT FROM OLD.phone AND auth.uid() IS NOT NULL THEN
    IF NOT is_admin() THEN
      SELECT regexp_replace(public._normalize_cuban_phone(au.phone), '\D', '', 'g')
        INTO v_verified
      FROM auth.users au
      WHERE au.id = OLD.id
        AND au.phone_confirmed_at IS NOT NULL;

      IF v_verified <> ''
         AND v_verified = regexp_replace(public._normalize_cuban_phone(NEW.phone), '\D', '', 'g') THEN
        NEW.phone := '+' || v_verified;
      ELSE
        PERFORM log_rpc_attempt('users_phone_guard', auth.uid(), OLD.id, 'reverted',
          jsonb_build_object('reason', CASE
            WHEN btrim(coalesce(NEW.phone, '')) = '' THEN 'cleared'
            WHEN coalesce(v_verified, '') = '' THEN 'no_verified_phone'
            ELSE 'not_the_verified_phone'
          END));
        NEW.phone := OLD.phone;
      END IF;
    END IF;
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
REVOKE ALL ON FUNCTION public.tg_users_protect_admin_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() TO service_role;

-- LIVE AFTER INSERT OR UPDATE OF role side effect: a 'driver' row gets a TriciCoin wallet.
CREATE OR REPLACE FUNCTION public.ensure_tricicoin_wallet_for_driver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.role = 'driver' THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- LIVE sign-up path: GoTrue inserts auth.users, this creates the public row.
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

-- LIVE triggers. BEFORE triggers of the same event fire in name order.
CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_normalize_phone();
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_protect_admin_fields();
CREATE TRIGGER users_ensure_tricicoin_wallet AFTER INSERT OR UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION ensure_tricicoin_wallet_for_driver();
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- LIVE policies on public.users (users_insert_own comes from 00001)
CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));

-- Hand everything to the non-superuser owner, as in prod. ALTER ... OWNER
-- rewrites the grantor of the grants above, and the tables' sequences follow.
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER TABLE auth.users OWNER TO tricigo_owner;
ALTER TABLE public.users OWNER TO tricigo_owner;
ALTER TABLE public.driver_profiles OWNER TO tricigo_owner;
ALTER TABLE public.wallet_accounts OWNER TO tricigo_owner;
ALTER TABLE public.rpc_attempt_log OWNER TO tricigo_owner;
ALTER FUNCTION auth.uid() OWNER TO tricigo_owner;
ALTER FUNCTION public.log_rpc_attempt(text, uuid, uuid, text, jsonb) OWNER TO tricigo_owner;
ALTER FUNCTION public.current_user_role() OWNER TO tricigo_owner;
ALTER FUNCTION public.is_admin() OWNER TO tricigo_owner;
ALTER FUNCTION public.is_super_admin() OWNER TO tricigo_owner;
ALTER FUNCTION public._normalize_cuban_phone(text) OWNER TO tricigo_owner;
ALTER FUNCTION public.tg_users_normalize_phone() OWNER TO tricigo_owner;
ALTER FUNCTION public.tg_users_protect_admin_fields() OWNER TO tricigo_owner;
ALTER FUNCTION public.ensure_tricicoin_wallet_for_driver() OWNER TO tricigo_owner;
ALTER FUNCTION public.handle_new_user() OWNER TO tricigo_owner;

-- Accounts live in seed.sql: run.sh reloads them before every test.
