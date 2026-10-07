-- Scaffold for the 00629 rehearsal: public.users with prod's LIVE protect trigger
-- (tg_users_protect_admin_fields, md5 377912e8…/2995 on 2026-10-07), the LIVE
-- is_admin / is_super_admin / current_user_role, the auth tables the block
-- touches (users.banned_until, sessions, refresh_tokens with prod's ON DELETE
-- CASCADE), driver_profiles and admin_actions.
-- Ownership mirrors prod: a non-superuser (tricigo_owner, standing in for
-- postgres) owns public; supabase_auth_admin owns auth and grants tricigo_owner
-- everything on its tables, like it grants postgres in prod.
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner, supabase_auth_admin TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, tricigo_owner;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

SET ROLE supabase_auth_admin;
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
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  phone text,
  phone_confirmed_at timestamptz,
  banned_until timestamptz
);
CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
CREATE TABLE auth.refresh_tokens (
  id bigserial PRIMARY KEY,
  token varchar(255),
  user_id varchar(255),
  revoked boolean,
  session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
);
GRANT ALL ON auth.users, auth.sessions, auth.refresh_tokens TO tricigo_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
RESET ROLE;

SET ROLE tricigo_owner;
CREATE TYPE public.user_role AS ENUM ('customer','driver','admin','super_admin');
CREATE TYPE public.user_level AS ENUM ('bronce','plata','oro','platino','diamante');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  level public.user_level NOT NULL DEFAULT 'bronce',
  phone text,
  total_rides integer NOT NULL DEFAULT 0,
  total_spent integer NOT NULL DEFAULT 0,
  cancellation_count integer NOT NULL DEFAULT 0,
  last_cancellation_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'approved',
  is_online boolean NOT NULL DEFAULT false,
  auto_offline_at timestamptz
);
CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.users, public.driver_profiles, public.admin_actions TO anon, authenticated, service_role;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;

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

-- Stubs for what the live protect trigger calls on the phone branch (not exercised here).
CREATE FUNCTION public.log_rpc_attempt(p_rpc text, p_caller uuid, p_target uuid, p_outcome text, p_meta jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE FUNCTION public._normalize_cuban_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p $$;

-- Live policies on users and driver_profiles (the ones these tests touch).
CREATE POLICY users_select_own ON public.users FOR SELECT USING (id = (SELECT auth.uid()));
CREATE POLICY users_admin_select ON public.users FOR SELECT USING ((SELECT is_admin()));
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY dp_select ON public.driver_profiles FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY dp_update_own ON public.driver_profiles FOR UPDATE USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY aa_select ON public.admin_actions FOR SELECT USING ((SELECT is_admin()));

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
RESET ROLE;
