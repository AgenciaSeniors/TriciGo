-- ============================================================
-- 00610 — Stop signed-in users from calling seven internal helpers
--         that act on someone else's driver, wallet or ride
--
-- WHY
--
-- These SECURITY DEFINER functions take another user's id (or an arbitrary
-- point) and never check who is asking. They were executable by every
-- signed-in user (and two of them by anon, through PUBLIC). No app, web page
-- or Edge Function calls them over the API, and no app version ever did
-- (git history of apps/, packages/ and supabase/functions/, 2026-10-06),
-- except find_best_drivers, see below. Their SQL callers are all SECURITY
-- DEFINER owned by postgres, so they keep working.
--
--   check_driver_eligibility(driver)   WRITES driver_profiles: any user could
--     flag another driver as financially ineligible, which drops them from
--     dispatch, or clear a flag. It also decides from the retired driver_cash
--     wallet. Measured: 243/243 drivers eligible and no driver_cash below the
--     threshold, so nobody has been blocked through it.
--   driver_can_afford_commission(driver, fare)  returns the exact tricicoin
--     wallet balance of any driver. Driver profile ids are handed out by
--     find_nearby_vehicles (to anon) and find_best_drivers.
--   find_best_drivers(point, ...)  returns every eligible online driver's
--     profile id, user id and exact distance to a point the caller picks:
--     three calls locate a driver. Client builds before 2026-06-13 (#510)
--     called it to send a redundant push, inside a try/catch; they lose that
--     redundant push and nothing else. Dispatch calls it server-side.
--   _waypoint_pricing(ride, lat, lng)  route length and surcharge of any ride.
--   get_driver_user_id(profile)  maps a driver profile to its user.
--   can_send_sms(user, max)  whether a user sent N SMS in the last hour.
--   driver_no_gps_rides_this_week(driver)  no caller at all.
--
-- Left alone on purpose (see the PR): calculate_cancellation_fee and
-- preview_cancellation_penalty (client builds before 2026-06-03 call them),
-- check_accept_ride_eligibility, calculate_ride_distance,
-- ensure_notification_preferences and increment_experiment_rides (the apps
-- call them), can_review_ride and corp_has_no_employees (RLS policies call
-- them), get_public_display_names and recompute_user_rating (public by
-- design), increment_promo_uses (its body is SELECT 1).
--
-- WHAT
--
-- REVOKE EXECUTE from PUBLIC, anon and authenticated on every overload of the
-- seven names; service_role keeps it. The closing block asserts the end state
-- from its own list of names, and checks as a signed-in user that a SECURITY
-- DEFINER caller can still reach them (a throwaway wrapper in pg_temp, rolled
-- back).
--
-- Idempotent: REVOKE and GRANT are no-ops when repeated.
-- ============================================================

SET lock_timeout = '5s';

DO $lock$
DECLARE
  v_names CONSTANT text[] := ARRAY[
    'check_driver_eligibility', 'driver_can_afford_commission', 'find_best_drivers',
    '_waypoint_pricing', 'get_driver_user_id', 'can_send_sms', 'driver_no_gps_rides_this_week'];
  v_missing text[];
  r record;
BEGIN
  SELECT array_agg(n ORDER BY n) INTO v_missing
  FROM unnest(v_names) AS n
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '00610: functions not found: %', v_missing;
  END IF;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_names)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END
$lock$;

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  r record;
  v_found int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('check_driver_eligibility', 'driver_can_afford_commission', 'find_best_drivers',
                        '_waypoint_pricing', 'get_driver_user_id', 'can_send_sms',
                        'driver_no_gps_rides_this_week')
  LOOP
    v_found := v_found + 1;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00610: anon can still execute %', r.sig;
    END IF;
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00610: authenticated can still execute %', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00610: service_role lost EXECUTE on %', r.sig;
    END IF;
  END LOOP;
  IF v_found < 7 THEN
    RAISE EXCEPTION '00610: expected at least 7 functions, found %', v_found;
  END IF;

  -- A SECURITY DEFINER caller run by a signed-in user still reaches the
  -- helpers, the way dispatch_ride and the notify triggers do. The block
  -- always raises, so the wrapper and the role change are rolled back.
  BEGIN
    CREATE FUNCTION pg_temp.zz_00610_probe() RETURNS integer
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
      AS $p$ SELECT count(public.get_driver_user_id(gen_random_uuid()))::integer $p$;
    GRANT EXECUTE ON FUNCTION pg_temp.zz_00610_probe() TO authenticated;
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
    SET LOCAL ROLE authenticated;
    PERFORM pg_temp.zz_00610_probe();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '00610_probe_ok';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00610_probe_ok' THEN
      RAISE EXCEPTION '00610: a SECURITY DEFINER caller lost access (%)', SQLERRM;
    END IF;
  END;
END
$check$;

RESET lock_timeout;
