-- 00665: a signup code can carry a promotion.
--
-- Marketing gives each influencer and channel a signup code (00619). Until now
-- it only recorded where a person came from. acquisition_codes.promotion_id
-- links a code to a promotion, and a person who registered with that code gets
-- the promotion on the next ride they create, without typing it:
--
--   rides_signup_promo          BEFORE INSERT on rides: fills in promo_code_id
--                               when the person typed none. It fires before
--                               rides_validate_promo_discount, which decides as
--                               it does for a typed code: active, dates, first
--                               ride, once per confirmed phone (00658), uses.
--   get_my_signup_promotion()   the linked promotion, only when the validator
--                               would accept it now. The apps show it before
--                               the person books.
--   admin_signup_code_stats()   + promotion_id, promotion_code, promo_rides.
--
-- tg_rides_signup_promo is SECURITY INVOKER on purpose. Inside a SECURITY
-- DEFINER function current_user is always the owner, and the trigger has to
-- tell a ride a person creates (current_user anon or authenticated) from one a
-- SECURITY DEFINER function, the cron or the service role creates. Clients
-- cannot read acquisition_codes (admin and marketing only), so the lookup goes
-- through _my_signup_promotion_id(), which answers only for auth.uid().
--
-- Deliveries (ride_mode other than passenger) and rides a company pays
-- (corporate_account_id) do not spend the welcome discount. The code's own
-- is_active does not matter: it only controls who can still register with it.

SET LOCAL lock_timeout = '10s';

-- 0. What this relies on is what was read from prod on 2026-10-17.
DO $guard$
DECLARE
  v_md5 text;
  v_result text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = to_regprocedure('public.tg_rides_validate_promo_discount()');
  IF v_md5 IS DISTINCT FROM 'cad4cf62d95e5055950b67564c6da7f4' THEN
    RAISE EXCEPTION '00665: tg_rides_validate_promo_discount() is not the body read from prod (md5 %)', v_md5;
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')), pg_get_function_result(oid) INTO v_md5, v_result
    FROM pg_proc WHERE oid = to_regprocedure('public.admin_signup_code_stats()');
  IF v_result IS NULL
     OR (v_result NOT LIKE '%promo_rides bigint%' AND v_md5 IS DISTINCT FROM '16a8ed1ebe03aa82f2f75676783a9099') THEN
    RAISE EXCEPTION '00665: admin_signup_code_stats() is not the body read from prod (md5 %)', v_md5;
  END IF;
END
$guard$;

-- 1. The link.
ALTER TABLE public.acquisition_codes
  ADD COLUMN IF NOT EXISTS promotion_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.acquisition_codes.promotion_id IS
  '00665: promotion applied to the next ride of people who registered with this code, while that promotion is active.';
CREATE INDEX IF NOT EXISTS idx_acquisition_codes_promotion
  ON public.acquisition_codes (promotion_id) WHERE promotion_id IS NOT NULL;

-- 2. The caller's linked promotion, for the trigger.
CREATE OR REPLACE FUNCTION public._my_signup_promotion_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT ac.promotion_id
    FROM public.users u
    JOIN public.acquisition_codes ac ON ac.code = u.signup_code
   WHERE u.id = auth.uid();
$function$;
REVOKE ALL ON FUNCTION public._my_signup_promotion_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._my_signup_promotion_id() TO authenticated, service_role;

-- 3. Fill in the promotion when a person creates a ride.
CREATE OR REPLACE FUNCTION public.tg_rides_signup_promo()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated')
     OR auth.uid() IS NULL
     OR NEW.customer_id IS DISTINCT FROM auth.uid()
     OR NEW.promo_code_id IS NOT NULL
     OR COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
     OR NEW.corporate_account_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Never block the ride: a failed lookup leaves it without the promotion.
  BEGIN
    IF public.is_admin() THEN
      RETURN NEW;
    END IF;
    v_promo := public._my_signup_promotion_id();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00665 tg_rides_signup_promo: lookup failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  -- Every rule (active, dates, first ride, once per phone, uses) belongs to
  -- the validator, which fires next and drops the promotion if one fails.
  IF v_promo IS NOT NULL THEN
    NEW.promo_code_id := v_promo;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_rides_signup_promo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_rides_signup_promo() TO service_role;

CREATE OR REPLACE TRIGGER rides_signup_promo
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_signup_promo();

-- 4. What the apps show before the person books.
CREATE OR REPLACE FUNCTION public.get_my_signup_promotion()
 RETURNS TABLE(code text, type text, discount_percent numeric, discount_fixed_cup integer,
               first_ride_only boolean, valid_until timestamp with time zone, signup_code text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  -- The rules tg_rides_validate_promo_discount applies when the ride is
  -- created (00658): the row is there exactly when rides_signup_promo would
  -- give the person the discount.
  RETURN QUERY
  SELECT p.code::text, p.type::text, p.discount_percent::numeric, p.discount_fixed_cup::integer,
         COALESCE(p.first_ride_only, false), p.valid_until, u.signup_code
    FROM public.users u
    JOIN public.acquisition_codes ac ON ac.code = u.signup_code
    JOIN public.promotions p ON p.id = ac.promotion_id
   WHERE u.id = v_uid
     AND p.is_active
     AND (p.valid_from IS NULL OR p.valid_from <= now())
     AND (p.valid_until IS NULL OR p.valid_until > now())
     AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
     AND NOT EXISTS (SELECT 1 FROM public.promotion_uses pu
                      WHERE pu.promotion_id = p.id AND pu.user_id = v_uid)
     AND public._reward_claim_status(v_uid, 'promo:' || p.id::text) = 'free'
     AND NOT (COALESCE(p.first_ride_only, false) AND EXISTS (
           SELECT 1 FROM public.rides r WHERE r.customer_id = v_uid AND r.status = 'completed'));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_signup_promotion() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_signup_promotion() TO authenticated, service_role;

-- 5. The code's results, with its promotion and how many rides used it.
-- New columns change the return type: DROP and CREATE, from the live body.
DROP FUNCTION IF EXISTS public.admin_signup_code_stats();
CREATE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean,
               created_at timestamp with time zone, signups bigint, rider_signups bigint,
               driver_signups bigint, drivers_approved bigint, riders_with_ride bigint,
               drivers_with_ride bigint, promotion_id uuid, promotion_code text, promo_rides bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
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
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed')),
    ac.promotion_id,
    p.code::text,
    (SELECT count(*) FROM public.rides r
       JOIN public.users ru ON ru.id = r.customer_id
      WHERE ru.signup_code = ac.code
        AND r.promo_code_id = ac.promotion_id
        AND r.status = 'completed')
  FROM public.acquisition_codes ac
  LEFT JOIN public.promotions p ON p.id = ac.promotion_id
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at, ac.promotion_id, p.code
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated, service_role;

-- 6. Pasted from Windows (CRLF), the bodies carry \r: rewrite them without it.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._my_signup_promotion_id()', 'public.tg_rides_signup_promo()',
    'public.get_my_signup_promotion()', 'public.admin_signup_code_stats()']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 7. Self-checks.
DO $check$
DECLARE
  v_ours text;
  v_validator text;
BEGIN
  -- BEFORE ROW triggers fire in name order (C collation); the validator has
  -- to see the promotion this trigger filled in.
  SELECT t.tgname::text INTO v_ours
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass
     AND t.tgfoid = 'public.tg_rides_signup_promo()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  SELECT min(t.tgname::text COLLATE "C") INTO v_validator
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.rides'::regclass
     AND t.tgfoid = 'public.tg_rides_validate_promo_discount()'::regprocedure
     AND t.tgenabled <> 'D' AND (t.tgtype & 7) = 7;
  IF v_ours IS NULL OR v_validator IS NULL OR NOT (v_ours COLLATE "C" < v_validator COLLATE "C") THEN
    RAISE EXCEPTION '00665: rides_signup_promo has to fire before the promo validator (ours %, validator %)',
      v_ours, v_validator;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.acquisition_codes'::regclass AND c.contype = 'f'
                    AND c.confrelid = 'public.promotions'::regclass AND c.confdeltype = 'n') THEN
    RAISE EXCEPTION '00665: acquisition_codes.promotion_id has to reference promotions ON DELETE SET NULL';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_rides_signup_promo()'::regprocedure) THEN
    RAISE EXCEPTION '00665: tg_rides_signup_promo() must be SECURITY INVOKER: current_user tells a client insert apart';
  END IF;

  IF has_function_privilege('anon', 'public.get_my_signup_promotion()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._my_signup_promotion_id()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE') THEN
    RAISE EXCEPTION '00665: anon can call a function it must not';
  END IF;
  IF NOT (has_function_privilege('authenticated', 'public.get_my_signup_promotion()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public._my_signup_promotion_id()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE')) THEN
    RAISE EXCEPTION '00665: authenticated lost EXECUTE on a function the apps or the panel call';
  END IF;

  IF position('is_marketing()' IN (SELECT prosrc FROM pg_proc
                                    WHERE oid = 'public.admin_signup_code_stats()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00665: admin_signup_code_stats() lost its admin-or-marketing gate';
  END IF;
END
$check$;
