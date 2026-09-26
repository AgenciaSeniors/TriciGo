-- ============================================================
-- 00599: users.phone only holds the number its account confirmed by OTP
--
-- A signed-in user can write any number to public.users.phone: PostgREST
-- grants UPDATE on the column, users_update_own lets the owner update its
-- row, and tg_users_protect_admin_fields puts back role, level and the
-- counters but not phone. No OTP is involved, and the column is not unique.
-- That number is what the rest of the platform trusts:
--   - find_user_by_phone: gift and fare-split recipient;
--   - find_recipient_for_recharge: diaspora recharge recipient (card money,
--     called by resolve-recharge-recipient and the NETOPIA and Stripe
--     create-*-recharge-intent functions);
--   - get_ride_contact_info (in-ride calls), notify_ride_status_sms and the
--     other SMS triggers, the admin screens, send-bulk-sms.
-- Reproduced locally with the live bodies (supabase/tests/00599): a customer
-- set her phone to a driver's number, and an account made with Google claimed
-- a number nobody had registered. Both lookups take LIMIT 1 without ORDER BY,
-- so the unregistered number resolved to the claimer every time, and the
-- driver's number did as soon as his row was written again (his next ride).
--
-- The number an account proved it owns is in auth.users: OTP sign-in and
-- link-phone set it together with phone_confirmed_at, and GoTrue keeps it
-- unique (users_phone_key) as E.164 digits without '+'. On 2026-09-25, 544 of
-- the 546 phones in public.users equal (normalized) their account's confirmed
-- number; the other 2 belong to admins without one. One of them repeats the
-- confirmed number of a driver account of the same person (Luis Manuel
-- Calero). It is left as is (owner decision, 2026-09-25): the lookups below
-- send that number to the driver account.
--
-- Fix:
--   1. tg_users_protect_admin_fields: a caller with a JWT that is not an
--      admin may only write the number its account confirmed, and it is
--      stored as E.164. Another number, one never confirmed, or NULL is put
--      back like the other protected fields (the rest of a multi-field save
--      goes through) and logged to rpc_attempt_log as users_phone_guard, with
--      a reason and without the number. It runs before the trusted tier and
--      cancel branches, so they cannot open it. Callers without a JWT
--      (link-phone's service-role mirror, triggers, cron) and admins are not
--      limited. The apps need no change: the verify-phone screens and the
--      driver onboarding write the number link-phone has just confirmed.
--   2. find_user_by_phone and 3. find_recipient_for_recharge resolve a number
--      through the one active account that confirmed it, and answer nobody
--      when there is none or more than one. Same signatures and privileges;
--      the gift lookup keeps its sign-in check and its rate limit.
--   4. A self-test that runs all three against a real account inside a block
--      that always rolls back (a plpgsql body is only checked when it runs),
--      and checks who may execute the lookups.
-- The trigger body is transcribed from pg_get_functiondef (prod md5
-- 2907fccbd0f2ec2201b7c0ec61d434a3, length 1701). The only changes are the
-- DECLARE and the block marked 00599; the rehearsal checks that byte for byte.
-- Rehearsal: supabase/tests/00599/run.sh.
-- ============================================================

-- 1. Write guard -----------------------------------------------------------------
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
            WHEN NEW.phone IS NULL THEN 'cleared'
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

-- 2. Gift and fare-split lookup ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_user_by_phone(p_phone text)
 RETURNS TABLE(id uuid, full_name text, phone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller UUID := auth.uid();
  v_rl     RECORD;
  v_digits TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;

  SELECT * INTO v_rl
  FROM check_rate_limit('find_user_by_phone:' || v_caller::text, 30, 3600);
  IF NOT v_rl.allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: max 30 phone lookups per hour';
  END IF;

  -- 00599: through the account that confirmed the number by OTP, never
  -- through users.phone. GoTrue keeps E.164 digits without '+'; both
  -- spellings use users_phone_key. More than one match would be a guess.
  v_digits := regexp_replace(public._normalize_cuban_phone(p_phone), '\D', '', 'g');
  IF v_digits IS NULL OR v_digits = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
    WITH m AS (
      SELECT u.id, u.full_name
      FROM auth.users au
      JOIN users u ON u.id = au.id
      WHERE au.phone IN (v_digits, '+' || v_digits)
        AND au.phone_confirmed_at IS NOT NULL
        AND u.is_active = true
    )
    SELECT m.id, m.full_name, '+' || v_digits
    FROM m
    WHERE (SELECT count(*) FROM m) = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.find_user_by_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_user_by_phone(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.find_user_by_phone(text) IS
  'Gift and fare-split recipient: the one active account whose number is confirmed by OTP in auth.users, or nobody. users.phone is not proof of ownership (00599).';

-- 3. Diaspora recharge lookup --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_recipient_for_recharge(p_phone text)
 RETURNS TABLE(id uuid, full_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  -- 00599: same resolution as find_user_by_phone.
  WITH n AS (
    SELECT regexp_replace(public._normalize_cuban_phone(p_phone), '\D', '', 'g') AS digits
  ), m AS (
    SELECT u.id, u.full_name
    FROM n
    JOIN auth.users au ON au.phone IN (n.digits, '+' || n.digits)
    JOIN users u ON u.id = au.id
    WHERE n.digits <> ''
      AND au.phone_confirmed_at IS NOT NULL
      AND u.is_active = true
  )
  SELECT m.id, m.full_name
  FROM m
  WHERE (SELECT count(*) FROM m) = 1;
$function$;

REVOKE ALL ON FUNCTION public.find_recipient_for_recharge(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_recipient_for_recharge(text) TO service_role;

COMMENT ON FUNCTION public.find_recipient_for_recharge(text) IS
  'Diaspora recharge recipient: the one active account whose number is confirmed by OTP in auth.users, or nobody. users.phone is not proof of ownership (00599).';

-- 4. Self-test ----------------------------------------------------------------------
-- Everything inside the inner block is rolled back, including the rows the
-- trigger logs and the rate-limit hits of the lookups.
DO $selftest$
DECLARE
  v_uid    uuid;
  v_phone  text;
  v_orphan text;
  v_got    text;
BEGIN
  IF has_function_privilege('anon', 'public.find_user_by_phone(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.find_recipient_for_recharge(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.find_recipient_for_recharge(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00599 self-test: a phone lookup is executable by a role that must not reach it';
  END IF;

  -- The oldest active customer or driver whose users.phone is its confirmed number.
  SELECT u.id, u.phone INTO v_uid, v_phone
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE u.is_active
    AND u.role IN ('customer', 'driver')
    AND au.phone_confirmed_at IS NOT NULL
    AND u.phone = '+' || regexp_replace(public._normalize_cuban_phone(au.phone), '\D', '', 'g')
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE NOTICE '00599 self-test skipped: no active customer or driver with a confirmed number';
    RETURN;
  END IF;

  -- The oldest active account whose users.phone no account confirmed (prod: a seeded admin).
  SELECT u.phone INTO v_orphan
  FROM public.users u
  WHERE u.is_active
    AND u.phone IS NOT NULL
    AND regexp_replace(public._normalize_cuban_phone(u.phone), '\D', '', 'g') NOT IN (
      SELECT regexp_replace(public._normalize_cuban_phone(au.phone), '\D', '', 'g')
      FROM auth.users au
      WHERE au.phone_confirmed_at IS NOT NULL
        AND au.phone IS NOT NULL)
  ORDER BY u.created_at, u.id
  LIMIT 1;

  BEGIN
    -- Under the account's own JWT, the number cannot move to one it never confirmed...
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    UPDATE public.users SET phone = '+5300000000' WHERE id = v_uid;
    SELECT u.phone INTO v_got FROM public.users u WHERE u.id = v_uid;
    IF v_got IS DISTINCT FROM v_phone THEN
      RAISE EXCEPTION '00599 self-test: a JWT that is not an admin moved users.phone to a number its account never confirmed';
    END IF;

    -- ...but the account can copy back the number it did confirm (a lost link-phone mirror).
    PERFORM set_config('request.jwt.claim.sub', '', true);
    UPDATE public.users SET phone = NULL WHERE id = v_uid;
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    UPDATE public.users SET phone = v_phone WHERE id = v_uid;
    SELECT u.phone INTO v_got FROM public.users u WHERE u.id = v_uid;
    IF v_got IS DISTINCT FROM v_phone THEN
      RAISE EXCEPTION '00599 self-test: an account could not copy back the number it confirmed';
    END IF;

    -- The lookups, for a caller whose rate limit is untouched.
    PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
    IF (SELECT f.id FROM public.find_user_by_phone(v_phone) f) IS DISTINCT FROM v_uid
       OR (SELECT r.id FROM public.find_recipient_for_recharge(v_phone) r) IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION '00599 self-test: a confirmed number does not resolve to its account';
    END IF;
    IF v_orphan IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.find_user_by_phone(v_orphan))
            OR EXISTS (SELECT 1 FROM public.find_recipient_for_recharge(v_orphan))) THEN
      RAISE EXCEPTION '00599 self-test: a number no account confirmed still resolves to someone';
    END IF;

    RAISE EXCEPTION '00599_selftest_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00599_selftest_rollback' THEN
      RAISE;
    END IF;
  END;
END
$selftest$;
