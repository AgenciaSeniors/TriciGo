-- ============================================================
-- 00671 — Operator role, delivery 3: live rides
-- ============================================================
--
-- Design: docs/superpowers/specs/2026-10-25-operator-role-design.md (§3, Delivery 3).
-- After 00668 the operator reads the assist page but every action refuses it. This migration lets
-- it assist searching rides, unstick active ones and cancel, through the same functions admins use.
--
-- A. Two helpers.
--    _ops_allow(ids) records, for the rest of the transaction, the rows an ops function is acting
--    on (app.ops_targets). _ops_acting_on(id) is true when the caller is ops staff and the id is in
--    that list. Only functions owned by postgres can call _ops_allow; a client cannot set app.*
--    settings through PostgREST, the same guarantee app.vehicle_rereview (00650) relies on.
--
-- B. The checks that would stop or silently undo an operator's action now let it through when it
--    acts inside one of these functions, as they let an admin through:
--    - enforce_ride_transition: the operator counts as an admin on that ride (as a customer
--      everywhere else, as since 00668). ride_transitions records it as 'admin'; actor_id names
--      the person;
--    - enforce_ride_update_columns: releasing a ride clears driver_id;
--    - tg_rides_validate_actuals: completing a ride stuck for hours;
--    - complete_ride_and_pay: its caller check (the driver or an admin).
--    tg_rides_require_delivery_proof stays as it is: the functions refuse a cargo ride without the
--    proof before the trigger would.
--
-- C. The functions open to the operator (is_admin() -> is_ops_staff()):
--    admin_offer_ride_to_driver, admin_assign_ride_to_driver, admin_change_ride_service (00628),
--    admin_release_active_ride, admin_advance_active_ride, admin_complete_active_ride (00660) and
--    admin_cancel_ride (00485). The 00628 functions and admin_cancel_ride gain the rule the 00660
--    ones already had, for every caller: nobody acts on a ride they ride in or drive
--    ('self_ride'), and nobody offers or assigns a ride to themselves.
--    Marketing stays out: is_ops_staff() is admin, super_admin or operator.
--
-- Each body is replaced only from its known md5 (the body in prod on 2026-11-02), each replaced
-- text must appear exactly once, and the migration checks the result. Re-applying it changes
-- nothing. Re-running 00485, 00628, 00660 or 00669 afterwards would put back the admin-only gates.

-- ── A. Helpers ──────────────────────────────────────────────
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

-- Only ops functions set the list. The check is called from triggers, also from SECURITY INVOKER
-- ones in a later delivery, so every role may call it; it reads only a setting clients cannot set.
REVOKE ALL ON FUNCTION public._ops_allow(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._ops_acting_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._ops_acting_on(uuid) TO anon, authenticated, service_role;

-- ── B and C. In-place patches ───────────────────────────────
-- p_olds[i] becomes p_news[i] in the body of p_fn; each must appear exactly once. A body with
-- p_new_md5 is already patched; any body but p_old_md5 stops the migration.
CREATE OR REPLACE FUNCTION pg_temp.m00671_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
                                               p_olds text[], p_news text[])
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_md5 text;
  v_def text;
  i integer;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00671: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00671: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
END
$function$;

-- B. enforce_ride_transition
SELECT pg_temp.m00671_patch('public.enforce_ride_transition()', '0f18b49d2d65e00923fa7f8d136b2387',
  '8081889db255282b67aaed2bfc9e458a',
  ARRAY[
    E'  IF v_user_role IN (''marketing'', ''operator'') THEN\n    v_user_role := ''customer'';\n  END IF;'
  ],
  ARRAY[
    E'  -- 00671: inside an ops function acting on this ride (_ops_allow), the operator moves it as\n'
    || E'  -- an admin.\n'
    || E'  IF v_user_role = ''operator'' AND public._ops_acting_on(NEW.id) THEN\n    v_user_role := ''admin'';\n'
    || E'  ELSIF v_user_role IN (''marketing'', ''operator'') THEN\n    v_user_role := ''customer'';\n  END IF;'
  ]);

-- B. enforce_ride_update_columns
SELECT pg_temp.m00671_patch('public.enforce_ride_update_columns()', '31af7a0b024555f25320def803642dba',
  '0b912f46f8ec7e63eca4777c4b28c495',
  ARRAY[E'  SELECT is_admin() INTO v_is_admin;'],
  ARRAY[E'  -- 00671: ops staff inside an ops function acting on this ride.\n'
        || E'  SELECT is_admin() OR public._ops_acting_on(NEW.id) INTO v_is_admin;']);

-- B. tg_rides_validate_actuals
SELECT pg_temp.m00671_patch('public.tg_rides_validate_actuals()', '5266e8d49fcd97eba56294556e886b85',
  '801600c034effe8a139944be5c4ec82a',
  ARRAY[E'  IF is_admin() THEN\n    RETURN NEW;\n  END IF;'],
  ARRAY[E'  -- 00671: ops staff inside an ops function acting on this ride.\n'
        || E'  IF is_admin() OR public._ops_acting_on(NEW.id) THEN\n    RETURN NEW;\n  END IF;']);

-- B. complete_ride_and_pay: the caller check only.
SELECT pg_temp.m00671_patch('public.complete_ride_and_pay(uuid,uuid,integer,integer)', 'dc8ddf9007b362ec0629d32a16d94920',
  '62298c877be639dbf69545f3c70d654e',
  ARRAY[E'IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN'],
  ARRAY[E'IF NOT is_admin() AND NOT public._ops_acting_on(p_ride_id) AND auth.uid() <> v_driver_user_id THEN']);

-- C. admin_offer_ride_to_driver: offers only, no ride write, so no _ops_allow.
SELECT pg_temp.m00671_patch('public.admin_offer_ride_to_driver(uuid,uuid)', 'fdbb9def0cc026200a6671b472343979',
  '0085408045cc5fbf2dbc3e2eb0da92f5',
  ARRAY[
    E'  IF NOT public.is_admin() THEN',
    E'  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(''error'', ''driver_not_found'');\n  END IF;'
  ],
  ARRAY[
    E'  IF NOT public.is_ops_staff() THEN',
    E'  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(''error'', ''driver_not_found'');\n  END IF;\n'
    || E'  -- 00671: nobody assists a ride they ride in, or offers a ride to themselves.\n'
    || E'  IF v_admin = v_ride.customer_id OR v_admin = v_dp.user_id THEN\n    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;'
  ]);

-- C. admin_assign_ride_to_driver
SELECT pg_temp.m00671_patch('public.admin_assign_ride_to_driver(uuid,uuid,text)', '3b082adbd39a6b3c0104bbd7ca3a4aa6',
  'ae15385d1c9cfbc109fe50d1ee396a4d',
  ARRAY[
    E'  IF NOT public.is_admin() THEN',
    E'  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(''error'', ''driver_not_found'');\n  END IF;'
  ],
  ARRAY[
    E'  IF NOT public.is_ops_staff() THEN',
    E'  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;\n  IF NOT FOUND THEN\n    RETURN jsonb_build_object(''error'', ''driver_not_found'');\n  END IF;\n'
    || E'  -- 00671: nobody assists a ride they ride in, or assigns a ride to themselves.\n'
    || E'  IF v_admin = v_ride.customer_id OR v_admin = v_dp.user_id THEN\n    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'
    || E'  PERFORM public._ops_allow(ARRAY[p_ride_id]);'
  ]);

-- C. admin_change_ride_service
SELECT pg_temp.m00671_patch('public.admin_change_ride_service(uuid,text,integer,text,text)', '35d88994a7e3978a478c06d6d499e4b6',
  '06b0af6654384570c38a76389681d43a',
  ARRAY[
    E'  IF NOT public.is_admin() THEN',
    E'  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);',
    E'  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);'
  ],
  ARRAY[
    E'  IF NOT public.is_ops_staff() THEN',
    E'  -- 00671: nobody assists a ride they ride in or drive.\n'
    || E'  IF v_admin = v_ride.customer_id\n'
    || E'     OR v_admin = (SELECT dp.user_id FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id) THEN\n'
    || E'    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'
    || E'  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);',
    E'  PERFORM public._ops_allow(ARRAY[p_ride_id]);\n'
    || E'  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);'
  ]);

-- C. The 00660 functions already refuse self_ride; they act on the ride right after.
SELECT pg_temp.m00671_patch(f.fn, f.old_md5, f.new_md5,
  ARRAY[
    E'  IF NOT public.is_admin() THEN',
    E'  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN\n    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;'
  ],
  ARRAY[
    E'  IF NOT public.is_ops_staff() THEN',
    E'  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN\n    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'
    || E'  PERFORM public._ops_allow(ARRAY[p_ride_id]);  -- 00671'
  ])
FROM (VALUES
  ('public.admin_release_active_ride(uuid,text,uuid,text)'::regprocedure, '3b8023a9675a976787964ad18f487a45', '8f18bf4984f52e41c93cdb16b062eeff'),
  ('public.admin_advance_active_ride(uuid,text,uuid,text)'::regprocedure, 'a713704024143056009faf750f838209', 'bc7187cb8d4dbde6c64886e2ee9e3ff8'),
  ('public.admin_complete_active_ride(uuid,text,uuid,integer,text)'::regprocedure, '8297bfe04b2b95f5321c5a15381631dd', '149e13089c12d43458a75ee58dd2a9d3')
) AS f(fn, old_md5, new_md5);

-- C. admin_cancel_ride
SELECT pg_temp.m00671_patch('public.admin_cancel_ride(uuid,text)', 'bf69819d3f06ba41fc2f1d3ee1f433d1',
  '21b4dfa6427e7c8976ef1324ddfa732b',
  ARRAY[
    E'  IF NOT is_admin() THEN',
    E'    RETURN jsonb_build_object(''error'', ''ride_already_closed'', ''status'', v_ride.status);\n  END IF;'
  ],
  ARRAY[
    E'  IF NOT public.is_ops_staff() THEN',
    E'    RETURN jsonb_build_object(''error'', ''ride_already_closed'', ''status'', v_ride.status);\n  END IF;\n\n'
    || E'  -- 00671: nobody cancels, as support, a ride they ride in or drive.\n'
    || E'  IF v_admin = v_ride.customer_id\n'
    || E'     OR v_admin = (SELECT dp.user_id FROM driver_profiles dp WHERE dp.id = v_ride.driver_id) THEN\n'
    || E'    RETURN jsonb_build_object(''error'', ''self_ride'');\n  END IF;\n'
    || E'  PERFORM public._ops_allow(ARRAY[p_ride_id]);'
  ]);

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._ops_allow(uuid[])', 'public._ops_acting_on(uuid)',
    'public.enforce_ride_transition()', 'public.enforce_ride_update_columns()',
    'public.tg_rides_validate_actuals()', 'public.complete_ride_and_pay(uuid,uuid,integer,integer)',
    'public.admin_offer_ride_to_driver(uuid,uuid)', 'public.admin_assign_ride_to_driver(uuid,uuid,text)',
    'public.admin_change_ride_service(uuid,text,integer,text,text)',
    'public.admin_release_active_ride(uuid,text,uuid,text)', 'public.admin_advance_active_ride(uuid,text,uuid,text)',
    'public.admin_complete_active_ride(uuid,text,uuid,integer,text)', 'public.admin_cancel_ride(uuid,text)'
  ]::regprocedure[] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Checks ──────────────────────────────────────────────────
DO $check$
DECLARE
  v_row record;
  v_set text;
  v_ok boolean;
BEGIN
  -- Every body is the one this migration writes.
  FOR v_row IN
    SELECT f.fn, f.want, md5(p.prosrc) AS got
    FROM (VALUES
      ('public._ops_allow(uuid[])'::regprocedure, '4762cf93cce4a747dc420cf3cdd7c7e9'),
      ('public._ops_acting_on(uuid)', '3fb1b0523206ef664115ce6be52cac17'),
      ('public.enforce_ride_transition()', '8081889db255282b67aaed2bfc9e458a'),
      ('public.enforce_ride_update_columns()', '0b912f46f8ec7e63eca4777c4b28c495'),
      ('public.tg_rides_validate_actuals()', '801600c034effe8a139944be5c4ec82a'),
      ('public.complete_ride_and_pay(uuid,uuid,integer,integer)', '62298c877be639dbf69545f3c70d654e'),
      ('public.admin_offer_ride_to_driver(uuid,uuid)', '0085408045cc5fbf2dbc3e2eb0da92f5'),
      ('public.admin_assign_ride_to_driver(uuid,uuid,text)', 'ae15385d1c9cfbc109fe50d1ee396a4d'),
      ('public.admin_change_ride_service(uuid,text,integer,text,text)', '06b0af6654384570c38a76389681d43a'),
      ('public.admin_release_active_ride(uuid,text,uuid,text)', '8f18bf4984f52e41c93cdb16b062eeff'),
      ('public.admin_advance_active_ride(uuid,text,uuid,text)', 'bc7187cb8d4dbde6c64886e2ee9e3ff8'),
      ('public.admin_complete_active_ride(uuid,text,uuid,integer,text)', '149e13089c12d43458a75ee58dd2a9d3'),
      ('public.admin_cancel_ride(uuid,text)', '21b4dfa6427e7c8976ef1324ddfa732b')
    ) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got <> v_row.want THEN
      RAISE EXCEPTION '00671 check: % md5 is %', v_row.fn, v_row.got;
    END IF;
  END LOOP;

  -- Only these functions call the ops helpers or the operator checks: 00668's nineteen and this
  -- migration's eleven. Any other body means a definition this migration did not foresee.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    ORDER BY p.proname) INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow)\s*\('
    AND p.proname NOT IN ('is_operator', 'is_ops_staff', '_ops_acting_on', '_ops_allow',
      -- 00668
      '_panel_driver_churn_risk', 'admin_active_ride_context', 'admin_get_online_fleet',
      'admin_incomplete_driver_signups', 'admin_launch_pulse', 'admin_ride_assist_candidates',
      'admin_ride_assist_context', 'admin_support_waiting_rides', 'get_admin_dashboard_metrics',
      'get_admin_wallet_stats', 'get_corporate_balance', 'get_corporate_employees',
      'get_driver_utilization', 'get_peak_hours', 'get_product_failures', 'get_rides_by_day',
      'get_rides_by_payment_method', 'get_rides_by_service_type', 'get_top_drivers',
      -- 00671
      'enforce_ride_transition', 'enforce_ride_update_columns', 'tg_rides_validate_actuals',
      'complete_ride_and_pay', 'admin_offer_ride_to_driver', 'admin_assign_ride_to_driver',
      'admin_change_ride_service', 'admin_release_active_ride', 'admin_advance_active_ride',
      'admin_complete_active_ride', 'admin_cancel_ride');
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00671 check: other functions call the ops checks: %', v_set;
  END IF;

  -- Money and roles stay admin-only.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_set
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('admin_adjust_wallet', 'admin_send_gift', 'admin_reverse_gift', 'freeze_wallet',
                      'unfreeze_wallet', 'approve_wallet_recharge', 'process_dispute_refund',
                      'admin_refund_ride_commission', 'admin_reward_referral', 'admin_invalidate_referral',
                      'set_referral_amounts', 'admin_send_wallet_v2_bonus_push', 'get_platform_earnings',
                      'promote_user_role', 'admin_set_user_level')
    AND p.prosrc ~ '(is_operator|is_ops_staff|_ops_acting_on|_ops_allow|''operator'')';
  IF v_set IS NOT NULL THEN
    RAISE EXCEPTION '00671 check: a money or role function names the operator: %', v_set;
  END IF;

  -- Permissions: the helper that sets the list is the owner's alone; the opened functions keep
  -- their grants (CREATE OR REPLACE does not change them).
  IF has_function_privilege('anon', 'public._ops_allow(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._ops_allow(uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._ops_allow(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public._ops_acting_on(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public._ops_acting_on(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00671 check: the helpers have the wrong permissions';
  END IF;
  FOR v_row IN
    SELECT f.fn FROM (VALUES
      ('public.admin_offer_ride_to_driver(uuid,uuid)'::regprocedure),
      ('public.admin_assign_ride_to_driver(uuid,uuid,text)'),
      ('public.admin_change_ride_service(uuid,text,integer,text,text)'),
      ('public.admin_release_active_ride(uuid,text,uuid,text)'),
      ('public.admin_advance_active_ride(uuid,text,uuid,text)'),
      ('public.admin_complete_active_ride(uuid,text,uuid,integer,text)'),
      ('public.admin_cancel_ride(uuid,text)'),
      ('public.complete_ride_and_pay(uuid,uuid,integer,integer)')
    ) AS f(fn)
  LOOP
    IF has_function_privilege('anon', v_row.fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_row.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00671 check: % has the wrong permissions', v_row.fn;
    END IF;
  END LOOP;

  -- Only ops staff act on a listed row: anon gets false even for a listed id, and nobody without
  -- the list. The list is put back as it was.
  v_set := pg_catalog.current_setting('app.ops_targets', true);
  PERFORM pg_catalog.set_config('app.ops_targets', '00000000-0000-4000-8000-000000000671', true);
  SET LOCAL ROLE anon;
  v_ok := public._ops_acting_on('00000000-0000-4000-8000-000000000671');
  RESET ROLE;
  PERFORM pg_catalog.set_config('app.ops_targets', COALESCE(v_set, ''), true);
  IF v_ok OR public._ops_acting_on(NULL) THEN
    RAISE EXCEPTION '00671 check: _ops_acting_on is true for anon or a null id';
  END IF;
END
$check$;
