-- ============================================================
-- 00677 — Company rides need no wallet of the driver's own
-- ============================================================
--
-- A driver must hold 15 % of the fare in their own tricicoin wallet to take a ride
-- (driver_can_afford_commission, called by accept_ride_v2 and by the two support functions that
-- offer or assign a ride). On a company ride that money never leaves the driver's wallet: the
-- commission comes out of the company's wallet (handle_corporate_ride_completion), and
-- complete_ride_and_pay has no commission step for payment_method = 'corporate'. So a fleet
-- driver with no balance could not take the rides of their own company.
--
-- The check is skipped on exactly the rides the company pays: payment_method = 'corporate' AND a
-- corporate_account_id. handle_corporate_ride_completion does nothing without the account (it
-- warns and returns), and a ride with an account but another payment method is charged to its
-- passenger or driver as usual, so in both cases the check stays.
--
--   accept_ride_v2                the driver taking the ride from the app
--   admin_assign_ride_to_driver   support assigning a ride to a driver
--   admin_ride_assist_candidates  the can_afford flag of the assist page (it marked such drivers
--                                 as unable to take the ride)
--
-- Every other gate stays as it is: the fleet gate (not_in_fleet), self_ride, the active-ride, the
-- online and the approval checks. check_accept_ride_eligibility and is_financially_eligible do not
-- change: the first has no ride to look at, the second starts at true and blocks nobody today.
--
-- Patched in place from the live body (pg_get_functiondef), each behind its md5: a body that
-- changed since this was written makes the migration refuse instead of overwriting it. Re-running
-- it is a no-op. No DROP and no DELETE.

CREATE OR REPLACE FUNCTION pg_temp.m00677_patch(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
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
    RAISE EXCEPTION '00677: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  FOR i IN 1 .. array_length(p_olds, 1) LOOP
    IF (length(v_def) - length(replace(v_def, p_olds[i], ''))) / length(p_olds[i]) <> 1 THEN
      RAISE EXCEPTION '00677: % does not have text % exactly once', p_fn, i;
    END IF;
    v_def := replace(v_def, p_olds[i], p_news[i]);
  END LOOP;
  EXECUTE v_def;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 IS DISTINCT FROM p_new_md5 THEN
    RAISE EXCEPTION '00677: % came out with md5 %, expected %', p_fn, v_md5, p_new_md5;
  END IF;
END
$function$;

-- accept_ride_v2: a NULL v_afford passes the gate below (COALESCE(NULL, true)).
SELECT pg_temp.m00677_patch('public.accept_ride_v2(uuid,uuid)', 'b51311095327fa66df27849ec9a4660f',
  'bf48ed429bebee25eccf9390ac3b56c0',
  ARRAY[E'  v_afford := driver_can_afford_commission(p_driver_id, v_ride.estimated_fare_cup);'],
  ARRAY[E'  -- 00677: the company pays the commission on a company ride, not the driver.\n'
        || E'  IF v_ride.payment_method::text = ''corporate'' AND v_ride.corporate_account_id IS NOT NULL THEN\n'
        || E'    v_afford := NULL;\n'
        || E'  ELSE\n'
        || E'    v_afford := driver_can_afford_commission(p_driver_id, v_ride.estimated_fare_cup);\n'
        || E'  END IF;']);

SELECT pg_temp.m00677_patch('public.admin_assign_ride_to_driver(uuid,uuid,text)', 'ae15385d1c9cfbc109fe50d1ee396a4d',
  '96a14f1ef39f9d397884457278efd699',
  ARRAY[E'  v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);'],
  ARRAY[E'  -- 00677: the company pays the commission on a company ride, not the driver.\n'
        || E'  IF v_ride.payment_method::text = ''corporate'' AND v_ride.corporate_account_id IS NOT NULL THEN\n'
        || E'    v_afford := NULL;\n'
        || E'  ELSE\n'
        || E'    v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);\n'
        || E'  END IF;']);

SELECT pg_temp.m00677_patch('public.admin_ride_assist_candidates(uuid,text)', '18ec24b4eff82a82c401df6889eb399c',
  'c97a27059673affa5f75bc024e09f6bb',
  ARRAY[E'         COALESCE((public.driver_can_afford_commission(dp.id, v_ride.estimated_fare_cup)->>''ok'')::boolean, false),'],
  ARRAY[E'         -- 00677: on a company ride the company pays the commission, so no driver lacks the balance.\n'
        || E'         (v_ride.payment_method::text = ''corporate'' AND v_ride.corporate_account_id IS NOT NULL)\n'
        || E'         OR COALESCE((public.driver_can_afford_commission(dp.id, v_ride.estimated_fare_cup)->>''ok'')::boolean, false),']);

-- Self-check: all three carry the condition, and nothing else of them changed.
DO $check$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.oid IN ('public.accept_ride_v2(uuid,uuid)'::regprocedure,
                  'public.admin_assign_ride_to_driver(uuid,uuid,text)'::regprocedure,
                  'public.admin_ride_assist_candidates(uuid,text)'::regprocedure)
    AND (position('payment_method::text = ''corporate'' AND v_ride.corporate_account_id IS NOT NULL' IN p.prosrc) = 0
         OR position(chr(13) IN p.prosrc) > 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00677: the company condition is missing, or a carriage return got in: %', v_bad;
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'public.driver_can_afford_commission(uuid,integer)'::regprocedure)
       <> 'cc0dde026b1e9262afbda4bde8f79723' THEN
    RAISE EXCEPTION '00677: driver_can_afford_commission changed; it must stay as it was';
  END IF;
END
$check$;
