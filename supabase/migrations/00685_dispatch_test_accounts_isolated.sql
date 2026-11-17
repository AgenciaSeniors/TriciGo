-- 00685: keep test accounts and real accounts apart in dispatch.
--
-- Why: to test the apps in prod (beta rounds run by an agent) a ride asked by a
-- test account must never ring a real driver, and a real ride must never go to
-- a test driver (the store demo driver, Carlos Hernandez, is approved and goes
-- online during app reviews). Until now nothing in dispatch looked at
-- users.is_test: a test ride got offers and pushes like any other.
--
-- The rule: a ride is offered to a driver only when the rider and the driver
-- are both test accounts or both real ones (_dispatch_same_test_world).
-- Applied in the two places that reach drivers on their own:
--   * dispatch_ride, which every automatic offer goes through (ride insert,
--     the retry cron, a driver going online, scheduled rides, released rides,
--     service changes). The rule sits next to the user_blocks filter, so an
--     expired offer across the line is never re-armed either.
--   * notify_offline_drivers_for_searching_rides, the "a rider is looking for
--     a ride, go online" push to offline drivers.
-- Support's manual offer and assignment (admin_offer_ride_to_driver,
-- admin_assign_ride_to_driver) are left as they are: a person picks the driver.
--
-- Both bodies are patched in place from the live ones (md5-guarded), so
-- nothing else in them changes; notify keeps its "-- 00679" line. A later
-- migration that redefines either function must start from the bodies this
-- one leaves (md5 36b69c9e... and dc738b43...).

-- 1. The rule. Only the owner calls it, from inside SECURITY DEFINER functions.
CREATE OR REPLACE FUNCTION public._dispatch_same_test_world(p_customer_id uuid, p_driver_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
  SELECT COALESCE((SELECT u.is_test FROM public.users u WHERE u.id = p_customer_id), false)
       = COALESCE((SELECT u.is_test FROM public.users u WHERE u.id = p_driver_user_id), false);
$fn$;

REVOKE ALL ON FUNCTION public._dispatch_same_test_world(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._dispatch_same_test_world(uuid, uuid) TO service_role;

-- 2. Patch both functions, refusing a body this migration does not know.
--    Re-running it once applied changes nothing.
DO $patch$
DECLARE
  c_dispatch  constant regprocedure := 'public.dispatch_ride(uuid, integer)'::regprocedure;
  c_notify    constant regprocedure := 'public.notify_offline_drivers_for_searching_rides()'::regprocedure;
  c_d_old     constant text := 'adec90cbff82dd8ffb77c07bfefa3086';
  c_d_new     constant text := '36b69c9e4c3cb6235d780e41099ea150';
  c_n_old     constant text := '38ca2bf6cdb427882fcfabe1b00a8b9d';
  c_n_new     constant text := 'dc738b434302e9f010ca8ff28d72b125';
  v_d_anchor  constant text := '  )' || chr(10) || '  ON CONFLICT (ride_id, driver_profile_id) DO UPDATE';
  v_d_repl    constant text := '  )' || chr(10)
    || '  -- 00685: a test account''s ride goes only to test drivers, a real ride only to real ones.' || chr(10)
    || '  AND public._dispatch_same_test_world(v_ride.customer_id, fbd.user_id)' || chr(10)
    || '  ON CONFLICT (ride_id, driver_profile_id) DO UPDATE';
  v_n_anchor  constant text := '               OR (ub.blocker_id = dp.user_id AND ub.blocked_id = r2.customer_id)' || chr(10)
    || '          )' || chr(10) || '      );';
  v_n_repl    constant text := '               OR (ub.blocker_id = dp.user_id AND ub.blocked_id = r2.customer_id)' || chr(10)
    || '          )' || chr(10)
    || '          AND public._dispatch_same_test_world(r2.customer_id, dp.user_id)  -- 00685' || chr(10)
    || '      );';
  v_src text;
  v_new text;
  v_def text;
BEGIN
  -- dispatch_ride
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_dispatch;
  IF md5(v_src) = c_d_new THEN
    RAISE NOTICE '00685: dispatch_ride already keeps test accounts apart';
  ELSIF md5(v_src) <> c_d_old THEN
    RAISE EXCEPTION '00685: dispatch_ride is not the body this migration knows (md5 %, length %)',
      md5(v_src), length(v_src);
  ELSE
    IF (length(v_src) - length(replace(v_src, v_d_anchor, ''))) / length(v_d_anchor) <> 1 THEN
      RAISE EXCEPTION '00685: the dispatch_ride anchor is not there exactly once';
    END IF;
    v_new := replace(v_src, v_d_anchor, v_d_repl);
    IF md5(v_new) <> c_d_new THEN
      RAISE EXCEPTION '00685: patched dispatch_ride has md5 %, expected %', md5(v_new), c_d_new;
    END IF;
    v_def := pg_get_functiondef(c_dispatch);
    IF position(v_src IN v_def) = 0 THEN
      RAISE EXCEPTION '00685: the dispatch_ride body is not inside pg_get_functiondef';
    END IF;
    EXECUTE replace(v_def, v_src, v_new);
  END IF;

  -- notify_offline_drivers_for_searching_rides
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_notify;
  IF md5(v_src) = c_n_new THEN
    RAISE NOTICE '00685: notify_offline_drivers_for_searching_rides already keeps test accounts apart';
  ELSIF md5(v_src) <> c_n_old THEN
    RAISE EXCEPTION '00685: notify_offline_drivers_for_searching_rides is not the body this migration knows (md5 %, length %)',
      md5(v_src), length(v_src);
  ELSE
    IF (length(v_src) - length(replace(v_src, v_n_anchor, ''))) / length(v_n_anchor) <> 1 THEN
      RAISE EXCEPTION '00685: the notify anchor is not there exactly once';
    END IF;
    v_new := replace(v_src, v_n_anchor, v_n_repl);
    IF md5(v_new) <> c_n_new THEN
      RAISE EXCEPTION '00685: patched notify has md5 %, expected %', md5(v_new), c_n_new;
    END IF;
    v_def := pg_get_functiondef(c_notify);
    IF position(v_src IN v_def) = 0 THEN
      RAISE EXCEPTION '00685: the notify body is not inside pg_get_functiondef';
    END IF;
    EXECUTE replace(v_def, v_src, v_new);
  END IF;
END
$patch$;

-- 3. Checks.
DO $check$
DECLARE
  c_dispatch constant regprocedure := 'public.dispatch_ride(uuid, integer)'::regprocedure;
  c_notify   constant regprocedure := 'public.notify_offline_drivers_for_searching_rides()'::regprocedure;
  c_rule     constant regprocedure := 'public._dispatch_same_test_world(uuid, uuid)'::regprocedure;
  r record;
BEGIN
  SELECT md5(prosrc) AS h, prosecdef AS sd INTO r FROM pg_proc WHERE oid = c_dispatch;
  IF r.h <> '36b69c9e4c3cb6235d780e41099ea150' OR NOT r.sd THEN
    RAISE EXCEPTION '00685 check: dispatch_ride is % (security definer %)', r.h, r.sd;
  END IF;
  SELECT md5(prosrc) AS h, prosecdef AS sd, position('-- 00679' IN prosrc) > 0 AS md INTO r FROM pg_proc WHERE oid = c_notify;
  IF r.h <> 'dc738b434302e9f010ca8ff28d72b125' OR NOT r.sd OR NOT r.md THEN
    RAISE EXCEPTION '00685 check: notify is % (security definer %, keeps 00679 %)', r.h, r.sd, r.md;
  END IF;
  -- dispatch_ride stays callable only by its owner and service_role (00630).
  IF has_function_privilege('authenticated', c_dispatch, 'EXECUTE')
     OR has_function_privilege('anon', c_dispatch, 'EXECUTE') THEN
    RAISE EXCEPTION '00685 check: a client can call dispatch_ride';
  END IF;
  IF has_function_privilege('authenticated', c_rule, 'EXECUTE')
     OR has_function_privilege('anon', c_rule, 'EXECUTE') THEN
    RAISE EXCEPTION '00685 check: a client can call _dispatch_same_test_world';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = c_rule) THEN
    RAISE EXCEPTION '00685 check: _dispatch_same_test_world is not SECURITY DEFINER';
  END IF;
  IF position(chr(13) IN (SELECT prosrc FROM pg_proc WHERE oid = c_rule)) > 0 THEN
    RAISE EXCEPTION '00685 check: _dispatch_same_test_world carries carriage returns';
  END IF;
  -- Two ids that are not users are both "real": the rule lets them meet.
  IF NOT public._dispatch_same_test_world(gen_random_uuid(), gen_random_uuid()) THEN
    RAISE EXCEPTION '00685 check: two unknown ids were kept apart';
  END IF;
END
$check$;
