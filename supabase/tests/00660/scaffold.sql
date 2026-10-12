-- Scaffold for the 00660 rehearsal (team invitations).
-- Prod's objects as of 2026-10-12, reduced to the columns 00660 reads. Every object belongs to a
-- NON-superuser role named postgres, as in prod. auth.uid() reads request.jwt.claim.sub like
-- PostgREST. Live bodies, byte for byte from prod (pg_get_functiondef): tg_users_protect_admin_fields
-- (00599, md5 377912e8...), is_admin, is_super_admin, current_user_role, mailable_user_emails;
-- run.sh S0 compares their md5 with prod.
-- Stubs: cron_http_post (records each call), get_service_role_key (empty when the session setting
-- test.no_key = '1'), log_rpc_attempt and _normalize_cuban_phone (the trigger's phone branch).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;
-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  phone text,
  phone_confirmed_at timestamptz,
  last_sign_in_at timestamptz
);
CREATE TABLE auth.identities (
  user_id       uuid NOT NULL,
  provider      text NOT NULL,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.user_level AS ENUM ('bronce', 'plata', 'oro', 'platino', 'diamante');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

CREATE TABLE public.users (
  id                   uuid PRIMARY KEY,
  email                text,
  full_name            text NOT NULL DEFAULT '',
  role                 public.user_role NOT NULL DEFAULT 'customer',
  is_active            boolean NOT NULL DEFAULT true,
  level                public.user_level NOT NULL DEFAULT 'bronce',
  phone                text,
  total_rides          integer NOT NULL DEFAULT 0,
  total_spent          integer NOT NULL DEFAULT 0,
  cancellation_count   integer NOT NULL DEFAULT 0,
  last_cancellation_at timestamptz,
  email_verified_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_profiles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id),
  status  public.driver_status NOT NULL
);
CREATE TABLE public.admin_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    uuid NOT NULL REFERENCES public.users (id),
  action      text NOT NULL,
  target_type text NOT NULL,
  target_id   text NOT NULL,
  old_values  jsonb,
  new_values  jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.team_digest_optouts (
  user_id    uuid PRIMARY KEY REFERENCES public.users (id) ON DELETE CASCADE,
  opted_out  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_digest_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_digest_optouts FROM anon, authenticated;

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
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;

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
$function$
;

CREATE OR REPLACE FUNCTION public.mailable_user_emails(p_user_ids uuid[])
 RETURNS TABLE(user_id uuid, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT u.id, btrim(u.email)
  FROM public.users u
  WHERE u.id = ANY (p_user_ids)
    AND btrim(coalesce(u.email, '')) <> ''
    AND (
      u.email_verified_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM auth.identities i
        WHERE i.user_id = u.id
          AND i.provider IN ('google', 'apple')
          AND lower(i.identity_data->>'email_verified') = 'true'
          AND lower(btrim(i.identity_data->>'email')) = lower(btrim(u.email))
      )
    );
$function$;
REVOKE ALL ON FUNCTION public.mailable_user_emails(uuid[]) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.log_rpc_attempt(p_rpc text, p_caller uuid, p_target uuid, p_outcome text, p_meta jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE FUNCTION public._normalize_cuban_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p $$;

-- Live policies the tests touch (the client's own role UPDATE and reads).
CREATE POLICY users_select_own ON public.users FOR SELECT USING (id = (SELECT auth.uid()));
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY aa_select ON public.admin_actions FOR SELECT USING ((SELECT is_admin()));

-- LIVE trigger body (prod 2026-10-12, md5 377912e83023297eda4761622a113364/2995).
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
$function$
;
CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_admin_fields();

-- Stubs: the vault key and the cron HTTP helper. cron_http_post records each call.
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT CASE current_setting('test.no_key', true) WHEN '1' THEN ''::text ELSE 'test-service-key'::text END
$$;
REVOKE ALL ON FUNCTION public.get_service_role_key() FROM PUBLIC, anon, authenticated;
CREATE TABLE public.cron_http_post_calls (
  id bigserial PRIMARY KEY,
  jobname text, url text, headers jsonb, body jsonb, timeout_ms integer
);
REVOKE ALL ON public.cron_http_post_calls FROM anon, authenticated;
CREATE OR REPLACE FUNCTION public.cron_http_post(
  p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 30000
) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO public.cron_http_post_calls (jobname, url, headers, body, timeout_ms)
  VALUES (p_jobname, url, headers, body, timeout_milliseconds) RETURNING id
$$;
REVOKE ALL ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) FROM PUBLIC, anon, authenticated;
RESET ROLE;

-- Test helpers (not production shapes).
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
-- t.outcome(sql) -> 'ok: <first column of the first row>' or 'raised <sqlstate>: <message> [<detail>]'
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $o$
DECLARE
  v text;
  v_detail text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'ok: ' || coalesce(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  RETURN 'raised ' || SQLSTATE || ': ' || SQLERRM || CASE WHEN coalesce(v_detail, '') <> '' THEN ' [' || v_detail || ']' ELSE '' END;
END $o$;
GRANT EXECUTE ON FUNCTION t.outcome(text) TO PUBLIC;
