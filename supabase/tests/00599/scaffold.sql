-- Scaffold for the 00599 rehearsal: the LIVE production shapes a write to
-- public.users.phone goes through, transcribed from pg_get_functiondef,
-- pg_policies, information_schema and pg_class.relacl on 2026-09-25.
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST sets it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role TO pgtest;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- auth.users: only the columns that matter here. GoTrue keeps phone as E.164
-- digits WITHOUT '+' (0 of 544 rows in prod start with '+'); users_phone_key
-- is the live unique index. Clients cannot read this table.
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email varchar(255),
  phone text DEFAULT NULL::character varying,
  phone_confirmed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX users_phone_key ON auth.users USING btree (phone);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');

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
-- LIVE relacl: {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
GRANT ALL ON public.users TO anon, authenticated, service_role;

-- Only what the admin branch of the protect trigger reads.
CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL);

-- LIVE: telemetry sink used by several RPCs and Edge Functions.
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

-- LIVE protect trigger (md5 2907fccbd0f2ec2201b7c0ec61d434a3, length 1701):
-- phone is in none of its branches.
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
REVOKE ALL ON FUNCTION public.tg_users_protect_admin_fields() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_users_protect_admin_fields() TO service_role;

-- LIVE triggers. BEFORE triggers of the same event fire in name order:
-- tg_users_normalize_phone runs before trg_users_protect_admin_fields.
CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_normalize_phone();
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION tg_users_protect_admin_fields();

-- LIVE policies on public.users
CREATE POLICY users_insert_own ON public.users FOR INSERT WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));

-- LIVE rate limiter shape, stubbed: it records every call, and Frank
-- (…000006) is always over his limit so the refusal can be tested.
CREATE TABLE public.rate_limit_calls (key text, max_requests integer, window_seconds integer);
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rate_limit_calls VALUES (p_key, p_max_requests, p_window_seconds);
  RETURN QUERY SELECT p_key NOT LIKE '%a0000000-0000-4000-8000-000000000006', 1, now() + make_interval(secs => p_window_seconds);
END;
$function$;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

-- LIVE phone lookups: gift / fare-split recipient (authenticated) and web
-- diaspora recharge recipient (service role, called by 3 Edge Functions).
-- Both trust public.users.phone and pick LIMIT 1 without ORDER BY.
CREATE OR REPLACE FUNCTION public.find_user_by_phone(p_phone text)
 RETURNS TABLE(id uuid, full_name text, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller UUID := auth.uid();
  v_rl     RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;

  SELECT * INTO v_rl
  FROM check_rate_limit('find_user_by_phone:' || v_caller::text, 30, 3600);
  IF NOT v_rl.allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: max 30 phone lookups per hour';
  END IF;

  RETURN QUERY
    SELECT u.id, u.full_name, u.phone
    FROM users u
    WHERE public._normalize_cuban_phone(u.phone) = public._normalize_cuban_phone(p_phone)
      AND u.is_active = true
    LIMIT 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.find_user_by_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_user_by_phone(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.find_recipient_for_recharge(p_phone text)
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT u.id, u.full_name
  FROM users u
  WHERE public._normalize_cuban_phone(u.phone) = public._normalize_cuban_phone(p_phone)
    AND u.is_active = true
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.find_recipient_for_recharge(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_recipient_for_recharge(text) TO service_role;

-- Accounts live in seed.sql: run.sh reloads them before every test.
