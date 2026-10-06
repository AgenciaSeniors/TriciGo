-- 00619: signup attribution codes (where a user heard of TriciGo).
--
-- Why: the launch plan for 2026-10-15 pays 14 influencer videos, UGC creators,
-- QR bags in markets, screens in cafés and posts in driver groups, and decides
-- where to move the budget by "registros por código". The app had no way to tell
-- where a signup came from: no utm, no source field, nothing typed at signup but
-- the driver's referral code.
--
-- Decision (2026-10-06): one optional "Código de invitación" field at signup
-- (client, web, driver). It takes either an acquisition code created in the admin
-- (this table) or a friend's referral code (unchanged: referrals still pay their
-- bonus). An acquisition code pays nothing; it only records the source.
--
--   acquisition_codes       admin-managed codes (MOTORENKO, BOLSAS-VEDADO, ...)
--   users.signup_code       the code the user gave, set once
--   apply_signup_code(code) 'applied' | 'already_set' | 'not_found' for the caller
--   admin_signup_code_stats() per code: signups, drivers, approvals, first rides
--
-- users.signup_code is written only by apply_signup_code: a trigger reverts any
-- change that comes straight from a client (anon/authenticated), so the source
-- can't be rewritten after the fact.
--
-- Rehearsal: supabase/tests/00619/run.sh

-- 1. The codes.
CREATE TABLE IF NOT EXISTS public.acquisition_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9-]{3,24}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  channel text NOT NULL CHECK (channel IN ('influencer', 'ugc', 'bolsas', 'pantallas', 'grupos', 'medios', 'otro')),
  audience text NOT NULL DEFAULT 'ambos' CHECK (audience IN ('pasajeros', 'choferes', 'ambos')),
  is_active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.acquisition_codes IS
  '00619: signup attribution codes managed in the admin. They pay no bonus.';

ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acquisition_codes_admin_all ON public.acquisition_codes;
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

GRANT SELECT, INSERT, UPDATE ON public.acquisition_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acquisition_codes TO service_role;
-- Until 2026-10-30 prod still grants new tables to anon by default.
REVOKE ALL ON public.acquisition_codes FROM anon;

-- A code typed at signup is looked up here first. One that is also somebody's
-- referral code would swallow that referral, so the two must never collide.
-- SECURITY DEFINER: the admin writes through PostgREST, and RLS on referral_codes
-- would hide every code but the admin's own, so the check would see nothing.
CREATE OR REPLACE FUNCTION public.tg_acquisition_codes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  NEW.code := upper(btrim(NEW.code));
  IF EXISTS (SELECT 1 FROM public.referral_codes WHERE code = NEW.code) THEN
    RAISE EXCEPTION 'El código % ya es un código de referido de un usuario', NEW.code
      USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_acquisition_codes_guard ON public.acquisition_codes;
CREATE TRIGGER trg_acquisition_codes_guard
  BEFORE INSERT OR UPDATE OF code ON public.acquisition_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_acquisition_codes_guard();

-- 2. Where each user came from.
SET lock_timeout = '5s';
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS signup_code text REFERENCES public.acquisition_codes(code) ON UPDATE CASCADE,
  ADD COLUMN IF NOT EXISTS signup_code_at timestamptz;
RESET lock_timeout;

COMMENT ON COLUMN public.users.signup_code IS
  '00619: acquisition code given at signup. Set once, by apply_signup_code only.';

CREATE INDEX IF NOT EXISTS idx_users_signup_code ON public.users (signup_code) WHERE signup_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_users_protect_signup_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- A client (PostgREST as anon/authenticated) never writes these columns;
  -- apply_signup_code runs as its owner and is not reverted.
  IF current_user IN ('anon', 'authenticated') THEN
    NEW.signup_code := OLD.signup_code;
    NEW.signup_code_at := OLD.signup_code_at;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_users_protect_signup_code ON public.users;
CREATE TRIGGER trg_users_protect_signup_code
  BEFORE UPDATE OF signup_code, signup_code_at ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_signup_code();

-- 3. The caller gives a code at signup.
CREATE OR REPLACE FUNCTION public.apply_signup_code(p_code text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_found text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT code INTO v_found FROM public.acquisition_codes
  WHERE code = v_code AND is_active;
  IF v_found IS NULL THEN
    RETURN 'not_found';
  END IF;

  UPDATE public.users
     SET signup_code = v_found, signup_code_at = now()
   WHERE id = v_uid AND signup_code IS NULL;
  IF FOUND THEN
    RETURN 'applied';
  END IF;
  RETURN 'already_set';
END;
$function$;

-- 4. Per-code results for the admin.
CREATE OR REPLACE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE (
   code text,
   label text,
   channel text,
   audience text,
   is_active boolean,
   created_at timestamptz,
   signups bigint,
   rider_signups bigint,
   driver_signups bigint,
   drivers_approved bigint,
   riders_with_ride bigint,
   drivers_with_ride bigint
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed'))
  FROM public.acquisition_codes ac
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;

-- 5. Who may call what. New functions are born executable by PUBLIC.
DO $grants$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION public.tg_acquisition_codes_guard() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.tg_users_protect_signup_code() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.apply_signup_code(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.tg_acquisition_codes_guard() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.tg_users_protect_signup_code() FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.apply_signup_code(text) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.apply_signup_code(text) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated;
  END IF;
END $grants$;
