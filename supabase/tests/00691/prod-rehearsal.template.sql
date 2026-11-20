-- Rehearsal of migration 00691 (the approval pays the driver approval bonus) against prod.
--
-- Everything runs in one DO block that always ends with an error, so the transaction rolls back and
-- prod is left as it was: the error message is the result,
--   "REHEARSAL 00691: <n> checks, <f> failures. <info> | <each failure>".
-- Nothing reaches a phone or an inbox: pg_net only sends what is committed.
-- Nothing is removed by hand: the drivers are created inside the block (all is_test, fictional numbers
-- +1 202 555 0191..0194, the range reserved for fiction), and QA Pasajero (ebdf285e…) acts as the
-- operator, and as an admin for one case. QA Moto stands for a driver approved before 00691.
--
-- prod-rehearsal.sql is this file with the migration pasted in; make-rehearsal.py builds it:
--   python -I supabase/tests/00691/make-rehearsal.py
-- Run prod-rehearsal.sql in the SQL Editor or through execute_sql, before applying 00691.
DO $rehearsal$
DECLARE
  c_mig_md5  constant text := '__MIGRATION_MD5__';
  c_pay_md5  constant text := '26d54b40b6770e5cb2269fd32d522878';
  c_ops_md5  constant text := '13154cbfcbcd4e63000d19aec08f07f1';
  c_ops_live constant text := 'a27519ab241af329cf374c9921e6479c';
  v_mig      text := $mig$__MIGRATION__$mig$;
  c_staff    constant uuid := 'ebdf285e-5016-4a86-9d52-013da2eadb25';
  c_moto_u   constant uuid := 'defc7431-e647-4f66-972d-468416624750';
  c_moto     constant uuid := '2cde9fb0-8d2c-4a4d-9d3f-5310a3771a3f';
  c_u1  constant uuid := 'a6860000-0000-4000-8000-000000000001';
  c_u2  constant uuid := 'a6860000-0000-4000-8000-000000000002';
  c_u3  constant uuid := 'a6860000-0000-4000-8000-000000000003';
  c_u4  constant uuid := 'a6860000-0000-4000-8000-000000000004';
  c_dp1 constant uuid := 'd6860000-0000-4000-8000-000000000001';
  c_dp2 constant uuid := 'd6860000-0000-4000-8000-000000000002';
  c_dp3 constant uuid := 'd6860000-0000-4000-8000-000000000003';
  c_dp4 constant uuid := 'd6860000-0000-4000-8000-000000000004';
  c_push constant text := '¡Tu cuenta de conductor ha sido aprobada! Te acreditamos 5000 CUP de bono. Ya puedes recibir viajes.';
  v_checks integer := 0;
  v_fails  text := '';
  v_info   text := '';
  v_out    jsonb;
  v_err    text;
  v_txt    text;
  v_n      bigint;
  v_m      bigint;
  v_a      bigint;
  v_b      bigint;
  v_t0     timestamptz := clock_timestamp();
BEGIN
  -- ── 0. The text arrived whole, and prod is as captured ──
  IF md5(v_mig) IS DISTINCT FROM c_mig_md5 THEN
    RAISE EXCEPTION 'REHEARSAL 00691: the migration text arrived changed (md5 %, expected %)', md5(v_mig), c_mig_md5;
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.ops_set_driver_status(uuid,text,text,text)')) IS DISTINCT FROM c_ops_live THEN
    RAISE EXCEPTION 'REHEARSAL 00691: ops_set_driver_status is not the 00672 body';
  END IF;
  IF to_regprocedure('public._pay_driver_approval_bonus(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL 00691: 00691 is already applied';
  END IF;

  -- ── Helpers (temporary, like everything here) ──
  CREATE FUNCTION pg_temp.r686_as(p_user uuid) RETURNS void LANGUAGE plpgsql AS $f$
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
    PERFORM set_config('request.jwt.claims',
      CASE WHEN p_user IS NULL THEN '' ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END, true);
  END $f$;
  CREATE FUNCTION pg_temp.r686_set(p_dp uuid, p_by uuid, p_status text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql AS $f$
  DECLARE
    v jsonb;
  BEGIN
    PERFORM pg_temp.r686_as(p_by);
    v := public.ops_set_driver_status(p_dp, p_status,
           (SELECT dp.status::text FROM public.driver_profiles dp WHERE dp.id = p_dp), p_reason);
    PERFORM pg_temp.r686_as(NULL);
    RETURN v;
  END $f$;
  CREATE FUNCTION pg_temp.r686_trc(p_user uuid) RETURNS bigint LANGUAGE sql AS $f$
    SELECT COALESCE((SELECT wa.balance FROM public.wallet_accounts wa
                      WHERE wa.user_id = p_user AND wa.account_type = 'tricicoin'), 0)::bigint
  $f$;
  CREATE FUNCTION pg_temp.r686_promo() RETURNS bigint LANGUAGE sql AS $f$
    SELECT wa.balance::bigint FROM public.wallet_accounts wa
     WHERE wa.user_id = '00000000-0000-0000-0000-000000000001' AND wa.account_type = 'platform_promotions'
  $f$;

  -- ── Seed: four drivers in review, never approved; QA Pasajero is the operator ──
  INSERT INTO auth.users (id, phone, phone_confirmed_at, aud, role, raw_user_meta_data)
  VALUES (c_u1, '12025550191', now(), 'authenticated', 'authenticated', '{"full_name": "Ensayo 00691 uno"}'),
         (c_u2, '12025550192', now(), 'authenticated', 'authenticated', '{"full_name": "Ensayo 00691 dos"}'),
         (c_u3, '12025550193', now(), 'authenticated', 'authenticated', '{"full_name": "Ensayo 00691 tres"}'),
         (c_u4, '12025550194', now(), 'authenticated', 'authenticated', '{"full_name": "Ensayo 00691 cuatro"}');
  UPDATE public.users SET is_test = true WHERE id IN (c_u1, c_u2, c_u3, c_u4);
  INSERT INTO public.driver_profiles (id, user_id, status)
  VALUES (c_dp1, c_u1, 'under_review'), (c_dp2, c_u2, 'under_review'),
         (c_dp3, c_u3, 'under_review'), (c_dp4, c_u4, 'under_review');
  INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number, is_active)
  VALUES (c_dp1, 'moto', 'Ensayo', '00691', 2020, 'gris', 'R686-01', true),
         (c_dp2, 'moto', 'Ensayo', '00691', 2020, 'gris', 'R686-02', true),
         (c_dp3, 'moto', 'Ensayo', '00691', 2020, 'gris', 'R686-03', true),
         (c_dp4, 'moto', 'Ensayo', '00691', 2020, 'gris', 'R686-04', true);
  UPDATE public.users SET role = 'operator' WHERE id = c_staff;

  -- ── RED: before 00691 the approval pays nothing ──
  BEGIN
    v_out := pg_temp.r686_set(c_dp1, c_staff, 'approved', NULL);
    v_checks := v_checks + 1;
    IF NOT COALESCE(v_out ->> 'success' = 'true' AND NOT (v_out ? 'bonus') AND pg_temp.r686_trc(c_u1) = 0
                    AND NOT EXISTS (SELECT 1 FROM public.ledger_transactions lt
                                     WHERE lt.idempotency_key = 'driver_approval_bonus:' || c_u1), false) THEN
      v_fails := v_fails || ' | RED: ' || COALESCE(v_out::text, 'null');
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- ── A copy with Windows line endings gives the same bodies ──
  BEGIN
    EXECUTE replace(v_mig, chr(10), chr(13) || chr(10));
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE (p.oid = to_regprocedure('public._pay_driver_approval_bonus(uuid,uuid)') AND md5(p.prosrc) = c_pay_md5)
        OR (p.oid = to_regprocedure('public.ops_set_driver_status(uuid,text,text,text)') AND md5(p.prosrc) = c_ops_md5);
    v_checks := v_checks + 1;
    IF v_n <> 2 THEN
      v_fails := v_fails || ' | CRLF copy: other bodies';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN OTHERS THEN
      v_checks := v_checks + 1;
      v_fails := v_fails || ' | CRLF copy failed: ' || SQLERRM;
  END;

  -- ── GREEN: 00691, twice (the second run changes nothing) ──
  EXECUTE v_mig;
  EXECUTE v_mig;

  -- Every driver approved before 00691 with a confirmed phone has it claimed; the four in review do not.
  SELECT count(*) INTO v_n FROM public.reward_claims rc
   WHERE rc.claim = 'driver_approval_bonus' AND rc.released_at IS NULL;
  SELECT count(*) INTO v_m
    FROM (SELECT DISTINCT dp.user_id FROM public.driver_profiles dp
            JOIN public.driver_first_approvals fa ON fa.driver_profile_id = dp.id
           WHERE dp.user_id IS NOT NULL AND public._reward_identity_hash(dp.user_id) IS NOT NULL) a;
  v_checks := v_checks + 1;
  IF v_n <> v_m OR public._reward_claim_status(c_u1, 'driver_approval_bonus') <> 'free'
     OR public._reward_claim_status(c_moto_u, 'driver_approval_bonus') <> 'taken' THEN
    v_fails := v_fails || format(' | claims %s, approved with a phone %s', v_n, v_m);
  END IF;
  v_info := v_info || format('claims=%s', v_n);

  -- D1: an operator's first approval pays 5000 from platform_promotions, kept in unbacked_cup.
  v_b := pg_temp.r686_promo();
  v_out := pg_temp.r686_set(c_dp1, c_staff, 'approved', NULL);
  v_checks := v_checks + 1;
  IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'paid' AND (v_out -> 'bonus' ->> 'amount_cup')::int = 5000
                  AND pg_temp.r686_trc(c_u1) = 5000 AND pg_temp.r686_promo() = v_b - 5000, false) THEN
    v_fails := v_fails || ' | D1 pay: ' || COALESCE(v_out::text, 'null');
  END IF;
  v_checks := v_checks + 1;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions lt
                  WHERE lt.idempotency_key = 'driver_approval_bonus:' || c_u1 AND lt.type = 'promo_credit'
                    AND lt.status = 'posted' AND lt.created_by = c_staff
                    AND lt.reference_type = 'driver_approval_bonus' AND lt.reference_id = c_dp1
                    AND (SELECT count(*) FROM public.ledger_entries le WHERE le.transaction_id = lt.id) = 2
                    AND (SELECT sum(le.amount) FROM public.ledger_entries le WHERE le.transaction_id = lt.id) = 0) THEN
    v_fails := v_fails || ' | D1 ledger';
  END IF;
  v_checks := v_checks + 1;
  IF NOT EXISTS (SELECT 1 FROM public.wallet_accounts wa
                  WHERE wa.user_id = c_u1 AND wa.account_type = 'tricicoin'
                    AND wa.unbacked_cup = 5000 AND COALESCE(wa.anchor_usd_cents, 0) = 0) THEN
    v_fails := v_fails || ' | D1 anchor: ' || COALESCE((SELECT row(wa.unbacked_cup, wa.anchor_usd_cents)::text
                                                         FROM public.wallet_accounts wa
                                                        WHERE wa.user_id = c_u1 AND wa.account_type = 'tricicoin'), 'none');
  END IF;
  v_checks := v_checks + 1;
  IF public._reward_claim_status(c_u1, 'driver_approval_bonus') <> 'taken' THEN
    v_fails := v_fails || ' | D1 claim';
  END IF;
  v_checks := v_checks + 1;
  IF NOT EXISTS (SELECT 1 FROM public.admin_actions aa
                  WHERE aa.action = 'approve_driver' AND aa.target_id = c_dp1::text AND aa.admin_id = c_staff
                    AND aa.new_values -> 'bonus' ->> 'status' = 'paid') THEN
    v_fails := v_fails || ' | D1 admin_actions';
  END IF;
  SELECT convert_from(q.body, 'UTF8')::jsonb ->> 'body' INTO v_txt
    FROM public.cron_http_calls c JOIN net.http_request_queue q ON q.id = c.request_id
   WHERE c.jobname = 'ops-driver-review' AND convert_from(q.body, 'UTF8')::jsonb -> 'user_ids' ? c_u1::text
   ORDER BY c.request_id DESC LIMIT 1;
  v_checks := v_checks + 1;
  IF v_txt IS DISTINCT FROM c_push THEN
    v_fails := v_fails || ' | D1 push: ' || COALESCE(v_txt, 'none');
  END IF;

  -- D2: a re-approval (after a suspension) pays nothing; the helper finds the ledger key.
  v_out := pg_temp.r686_set(c_dp1, c_staff, 'suspended', 'ensayo 00691');
  v_out := pg_temp.r686_set(c_dp1, c_staff, 'approved', NULL);
  v_checks := v_checks + 1;
  IF NOT COALESCE(v_out ->> 'success' = 'true' AND v_out -> 'bonus' = 'null'::jsonb AND pg_temp.r686_trc(c_u1) = 5000
                  AND (SELECT count(*) FROM public.ledger_transactions lt
                        WHERE lt.idempotency_key = 'driver_approval_bonus:' || c_u1) = 1, false) THEN
    v_fails := v_fails || ' | D2 re-approval: ' || COALESCE(v_out::text, 'null');
  END IF;
  v_checks := v_checks + 1;
  IF public._pay_driver_approval_bonus(c_dp1, c_staff) ->> 'status' IS DISTINCT FROM 'already_paid' THEN
    v_fails := v_fails || ' | D2 ledger key';
  END IF;

  -- D3: an admin's first approval pays too.
  UPDATE public.users SET role = 'admin' WHERE id = c_staff;
  v_out := pg_temp.r686_set(c_dp2, c_staff, 'approved', NULL);
  UPDATE public.users SET role = 'operator' WHERE id = c_staff;
  v_checks := v_checks + 1;
  IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'paid' AND pg_temp.r686_trc(c_u2) = 5000, false) THEN
    v_fails := v_fails || ' | D3 admin: ' || COALESCE(v_out::text, 'null');
  END IF;

  -- D4: a phone that already got it (another account) does not get it again.
  PERFORM public._claim_reward(c_u3, 'driver_approval_bonus', NULL, NULL);
  v_out := pg_temp.r686_set(c_dp3, c_staff, 'approved', NULL);
  v_checks := v_checks + 1;
  IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'already_paid' AND pg_temp.r686_trc(c_u3) = 0
                  AND NOT EXISTS (SELECT 1 FROM public.ledger_transactions lt
                                   WHERE lt.idempotency_key = 'driver_approval_bonus:' || c_u3), false) THEN
    v_fails := v_fails || ' | D4 phone taken: ' || COALESCE(v_out::text, 'null');
  END IF;

  -- D5: amount 0 turns it off, and claims nothing.
  BEGIN
    UPDATE public.platform_config SET value = '0'::jsonb WHERE key = 'driver_approval_bonus_cup';
    v_out := pg_temp.r686_set(c_dp4, c_staff, 'approved', NULL);
    v_checks := v_checks + 1;
    IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'disabled' AND pg_temp.r686_trc(c_u4) = 0
                    AND public._reward_claim_status(c_u4, 'driver_approval_bonus') = 'free', false) THEN
      v_fails := v_fails || ' | D5 off: ' || COALESCE(v_out::text, 'null');
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- D6: an amount that is not a whole number from 1 to 50000 pays nothing and is logged.
  FOREACH v_txt IN ARRAY ARRAY['999999', '"abc"', '2500.5', '-5'] LOOP
    BEGIN
      UPDATE public.platform_config SET value = v_txt::jsonb WHERE key = 'driver_approval_bonus_cup';
      v_out := pg_temp.r686_set(c_dp4, c_staff, 'approved', NULL);
      v_checks := v_checks + 1;
      IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'invalid_amount' AND pg_temp.r686_trc(c_u4) = 0
                      AND EXISTS (SELECT 1 FROM public.rpc_attempt_log l
                                   WHERE l.rpc_name = 'driver_approval_bonus' AND l.target_id = c_dp4
                                     AND l.outcome = 'invalid_amount'), false) THEN
        v_fails := v_fails || ' | D6 amount ' || v_txt || ': ' || COALESCE(v_out::text, 'null');
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0099';
    EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
    END;
  END LOOP;

  -- D7: a payment that fails leaves the approval standing, moves no money and is logged.
  BEGIN
    CREATE OR REPLACE FUNCTION public._claim_reward(p_user_id uuid, p_claim text, p_ride_id uuid DEFAULT NULL::uuid,
                                                    p_referral_id uuid DEFAULT NULL::uuid)
     RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
    AS $f$ BEGIN RAISE EXCEPTION 'rehearsal 00691: injected failure'; END $f$;
    v_b := pg_temp.r686_promo();
    v_out := pg_temp.r686_set(c_dp4, c_staff, 'approved', NULL);
    v_checks := v_checks + 1;
    IF NOT COALESCE(v_out ->> 'success' = 'true' AND v_out -> 'bonus' ->> 'status' = 'failed'
                    AND (SELECT dp.status::text FROM public.driver_profiles dp WHERE dp.id = c_dp4) = 'approved'
                    AND pg_temp.r686_trc(c_u4) = 0 AND pg_temp.r686_promo() = v_b
                    AND EXISTS (SELECT 1 FROM public.rpc_attempt_log l
                                 WHERE l.rpc_name = 'driver_approval_bonus' AND l.target_id = c_dp4
                                   AND l.outcome = 'payment_failed'
                                   AND l.metadata ->> 'error' LIKE '%injected failure%'), false) THEN
      v_fails := v_fails || ' | D7 failure: ' || COALESCE(v_out::text, 'null');
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- D8: no confirmed phone, no bonus.
  BEGIN
    CREATE OR REPLACE FUNCTION public._reward_identity_hash(p_user_id uuid)
     RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
    AS $f$ BEGIN RETURN NULL; END $f$;
    v_out := pg_temp.r686_set(c_dp4, c_staff, 'approved', NULL);
    v_checks := v_checks + 1;
    IF NOT COALESCE(v_out -> 'bonus' ->> 'status' = 'no_phone' AND pg_temp.r686_trc(c_u4) = 0, false) THEN
      v_fails := v_fails || ' | D8 no phone: ' || COALESCE(v_out::text, 'null');
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  -- D9: a driver approved before 00691 (QA Moto) is not paid when approved again.
  v_a := pg_temp.r686_trc(c_moto_u);
  v_out := pg_temp.r686_set(c_moto, c_staff, 'suspended', 'ensayo 00691');
  v_out := pg_temp.r686_set(c_moto, c_staff, 'approved', NULL);
  v_checks := v_checks + 1;
  IF NOT COALESCE(v_out ->> 'success' = 'true' AND v_out -> 'bonus' = 'null'::jsonb
                  AND pg_temp.r686_trc(c_moto_u) = v_a, false) THEN
    v_fails := v_fails || ' | D9 approved before: ' || COALESCE(v_out::text, 'null');
  END IF;

  -- D10: no client can run the payment.
  v_checks := v_checks + 1;
  IF has_function_privilege('anon', to_regprocedure('public._pay_driver_approval_bonus(uuid,uuid)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public._pay_driver_approval_bonus(uuid,uuid)'), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure('public._pay_driver_approval_bonus(uuid,uuid)'), 'EXECUTE') THEN
    v_fails := v_fails || ' | D10 grants';
  END IF;

  -- N1-N3: the migration's own checks refuse what they must.
  BEGIN
    SELECT pg_get_functiondef(to_regprocedure('public.ops_set_driver_status(uuid,text,text,text)')) INTO v_txt;
    EXECUTE replace(v_txt, 'BEGIN' || chr(10) || '  IF NOT public.is_ops_staff()',
                    'BEGIN' || chr(10) || '  -- tampered' || chr(10) || '  IF NOT public.is_ops_staff()');
    BEGIN
      EXECUTE v_mig;
      v_err := 'no error';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    v_checks := v_checks + 1;
    IF v_err NOT LIKE '00691: ops_set_driver_status has md5 %' THEN
      v_fails := v_fails || ' | N1 another body: ' || v_err;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    CREATE FUNCTION public.r686_rogue() RETURNS jsonb LANGUAGE sql
    AS $f$ SELECT public._pay_driver_approval_bonus(NULL::uuid, NULL::uuid) $f$;
    BEGIN
      EXECUTE v_mig;
      v_err := 'no error';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    v_checks := v_checks + 1;
    IF v_err NOT LIKE '00691 check: 1 other function(s) call _pay_driver_approval_bonus' THEN
      v_fails := v_fails || ' | N2 another caller: ' || v_err;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    GRANT EXECUTE ON FUNCTION public.ops_set_driver_status(uuid, text, text, text) TO anon;
    BEGIN
      EXECUTE v_mig;
      v_err := 'no error';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    v_checks := v_checks + 1;
    IF v_err IS DISTINCT FROM '00691 check: ops_set_driver_status has the wrong grants' THEN
      v_fails := v_fails || ' | N3 grants: ' || v_err;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  RAISE EXCEPTION 'REHEARSAL 00691: % checks, % failures. % | % ms%',
    v_checks, (length(v_fails) - length(replace(v_fails, ' | ', ''))) / 3, v_info,
    round(extract(epoch FROM clock_timestamp() - v_t0) * 1000), v_fails;
END
$rehearsal$;
