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
  c_mig_md5  constant text := 'daf9d0c742932de477d260e5af05f415';
  c_pay_md5  constant text := '26d54b40b6770e5cb2269fd32d522878';
  c_ops_md5  constant text := '13154cbfcbcd4e63000d19aec08f07f1';
  c_ops_live constant text := 'a27519ab241af329cf374c9921e6479c';
  v_mig      text := $mig$-- 00691: the approval pays the driver approval bonus.
--
-- Every approved driver gets a bonus in their tricicoin wallet: 5000 CUP since late August 2026
-- (10000 before). Until now an admin loaded it by hand with admin_adjust_wallet right after
-- approving. Measured in prod on 2026-11-17: 242 of the 243 approved real drivers got it; the 7
-- drivers an operator approved on 2026-11-15 waited 17 to 21 hours for an admin (operators approve
-- drivers, 00672, but have no money function); one driver was paid twice two minutes apart, and
-- another was paid again on a re-approval. Owner's decision (2026-11-17): the approval pays it,
-- whoever approves. Design: docs/superpowers/specs/2026-11-17-driver-approval-bonus-design.md.
--
-- 1. platform_config.driver_approval_bonus_cup = 5000. 0 turns the bonus off. A value that is not a
--    whole number from 1 to 50000 pays nothing and leaves an invalid_amount row in rpc_attempt_log.
-- 2. public._pay_driver_approval_bonus(driver_profile_id, paid_by): from platform_promotions to the
--    driver's tricicoin, as a promo_credit. The USD anchor trigger keeps a promo_credit in
--    unbacked_cup, so the bonus stays nominal CUP and is never revalued, as the credits of
--    admin_adjust_wallet. Once per account (ledger idempotency key driver_approval_bonus:<user_id>)
--    and once per confirmed phone (_claim_reward, 00658): no confirmed phone, no bonus. It never
--    raises: a failure is logged (driver_approval_bonus / payment_failed) and returned as
--    {"status": "failed"}. Only its owner can run it.
-- 3. ops_set_driver_status (00672) calls it on the profile's first approval only: no approved_at and
--    no driver_first_approvals row before the update. A re-approval (after a suspension, a rejection
--    or a vehicle change, 00650) pays nothing. The function returns the outcome as "bonus", keeps it
--    in the approve_driver row of admin_actions and says it in the approval push.
-- 4. The phone of every driver approved so far is claimed: they got the bonus by hand, and a new
--    account with the same phone must not get it again.
--
-- The operator still has no money function. The approval pays a fixed, configured amount, once per
-- person; whoever approves cannot choose the amount, the recipient or a second payment.
--
-- Live body this patches (md5 of prosrc): ops_set_driver_status a27519ab241af329cf374c9921e6479c.
-- Rehearsed in prod in rolled-back blocks before applying: supabase/tests/00691/prod-rehearsal.sql.
-- This file has no backslash, so it travels through any tool unchanged.

-- ── 1. The amount ───────────────────────────────────────────
INSERT INTO public.platform_config (key, value)
VALUES ('driver_approval_bonus_cup', '5000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 2. The payment ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pay_driver_approval_bonus(p_driver_profile_id uuid, p_paid_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- The platform's account pays the promotions (the referral triggers, 00666).
  v_platform_user constant uuid := '00000000-0000-0000-0000-000000000001';
  -- A guard against a typo with extra zeros, not the amount: the amount is the config key.
  v_max constant integer := 50000;
  v_raw numeric;
  v_amount integer;
  v_user uuid;
  v_key text;
  v_claim text;
  v_driver_account uuid;
  v_platform_account uuid;
  v_driver_balance integer;
  v_platform_balance integer;
  v_txn uuid;
BEGIN
  -- NULL when the key is missing or is not a number.
  v_raw := public.get_platform_config_numeric('driver_approval_bonus_cup', NULL);
  IF v_raw = 0 OR (v_raw IS NULL AND NOT EXISTS (
       SELECT 1 FROM public.platform_config pc WHERE pc.key = 'driver_approval_bonus_cup')) THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;

  SELECT dp.user_id INTO v_user FROM public.driver_profiles dp WHERE dp.id = p_driver_profile_id;
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'no_driver');
  END IF;

  IF v_raw IS NULL OR v_raw < 1 OR v_raw > v_max OR v_raw <> trunc(v_raw) THEN
    PERFORM public.log_rpc_attempt('driver_approval_bonus', p_paid_by, p_driver_profile_id, 'invalid_amount',
      jsonb_build_object('amount', v_raw, 'max', v_max));
    RETURN jsonb_build_object('status', 'invalid_amount');
  END IF;
  v_amount := v_raw::integer;

  -- Once per account: a profile deleted and created again for the same account finds the key.
  v_key := 'driver_approval_bonus:' || v_user::text;
  IF EXISTS (SELECT 1 FROM public.ledger_transactions lt WHERE lt.idempotency_key = v_key) THEN
    RETURN jsonb_build_object('status', 'already_paid');
  END IF;

  -- The money block: a failure rolls back the claim and the money together, never the approval.
  BEGIN
    -- Once per confirmed phone (00658): a new account with the same phone finds the claim.
    v_claim := public._claim_reward(v_user, 'driver_approval_bonus', NULL, NULL);
    IF v_claim = 'no_phone' THEN
      RETURN jsonb_build_object('status', 'no_phone');
    ELSIF v_claim IS DISTINCT FROM 'claimed' THEN
      RETURN jsonb_build_object('status', 'already_paid');
    END IF;

    v_driver_account := public.ensure_wallet_account(v_user, 'tricicoin');
    v_platform_account := public.ensure_wallet_account(v_platform_user, 'platform_promotions');
    -- Platform first, then the driver: the order of the referral triggers and of 00666.
    SELECT wa.balance INTO v_platform_balance
      FROM public.wallet_accounts wa WHERE wa.id = v_platform_account FOR UPDATE;
    SELECT wa.balance INTO v_driver_balance
      FROM public.wallet_accounts wa WHERE wa.id = v_driver_account FOR UPDATE;

    INSERT INTO public.ledger_transactions (idempotency_key, type, status, reference_type, reference_id,
                                            description, metadata, created_by)
    VALUES (v_key, 'promo_credit', 'posted', 'driver_approval_bonus', p_driver_profile_id,
            'Bono de aprobación de conductor',
            jsonb_build_object('driver_profile_id', p_driver_profile_id, 'approved_by', p_paid_by),
            p_paid_by)
    RETURNING id INTO v_txn;

    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn, v_platform_account, -v_amount, v_platform_balance - v_amount),
           (v_txn, v_driver_account, v_amount, v_driver_balance + v_amount);
    UPDATE public.wallet_accounts SET balance = balance - v_amount, updated_at = now()
     WHERE id = v_platform_account;
    UPDATE public.wallet_accounts SET balance = balance + v_amount, updated_at = now()
     WHERE id = v_driver_account;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'driver approval bonus failed for driver profile %: % %', p_driver_profile_id, SQLSTATE, SQLERRM;
    -- Written after the block rolled back, so the record stays. log_rpc_attempt swallows its own
    -- errors; the inner block covers it missing.
    BEGIN
      PERFORM public.log_rpc_attempt('driver_approval_bonus', p_paid_by, p_driver_profile_id, 'payment_failed',
        jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM, 'amount_cup', v_amount));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'driver approval bonus: logging the failure for driver profile % failed: % %',
        p_driver_profile_id, SQLSTATE, SQLERRM;
    END;
    RETURN jsonb_build_object('status', 'failed');
  END;

  RETURN jsonb_build_object('status', 'paid', 'amount_cup', v_amount, 'transaction_id', v_txn);
END
$function$;

-- Only its owner runs it: ops_set_driver_status (SECURITY DEFINER, same owner) after its own checks.
REVOKE ALL ON FUNCTION public._pay_driver_approval_bonus(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. The approval pays it ─────────────────────────────────
-- Patched from the live body, so nothing else of it can change: each piece must appear exactly once,
-- and the result must have the md5 the rehearsal measured. Carriage returns are taken out of the
-- pieces, so a copy pasted from Windows patches the same.
DO $patch$
DECLARE
  c_fn   constant regprocedure := 'public.ops_set_driver_status(uuid,text,text,text)'::regprocedure;
  c_live constant text := 'a27519ab241af329cf374c9921e6479c';
  c_new  constant text := '13154cbfcbcd4e63000d19aec08f07f1';
  v_md5  text;
  v_def  text;
  v_from text[];
  v_to   text[];
  v_piece text;
  i int;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = c_fn;
  IF v_md5 = c_new THEN
    RAISE NOTICE '00691: ops_set_driver_status is already patched';
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM c_live THEN
    RAISE EXCEPTION '00691: ops_set_driver_status has md5 %, expected % (00672). Capture the live body again before patching it.',
      v_md5, c_live;
  END IF;

  v_from := ARRAY[
'  v_body    text;
BEGIN
',
'  IF p_status = ''approved'' THEN
    UPDATE public.driver_profiles SET status = ''approved'', approved_at = now() WHERE id = v_dp.id;
',
'

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
',
'          jsonb_build_object(''status'', v_dp.status), jsonb_build_object(''status'', p_status), v_reason);
',
'  RETURN jsonb_build_object(''success'', true, ''status'', p_status, ''previous_status'', v_dp.status);
'];
  v_to := ARRAY[
'  v_body    text;
  v_first   boolean := false;
  v_bonus   jsonb;
BEGIN
',
'  IF p_status = ''approved'' THEN
    -- 00691: only the profile''s first approval pays the approval bonus. A re-approval (after a
    -- suspension, a rejection or a vehicle change, 00650) finds approved_at set or the
    -- driver_first_approvals row the update below writes on the first one.
    v_first := v_dp.approved_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM public.driver_first_approvals fa WHERE fa.driver_profile_id = v_dp.id);
    UPDATE public.driver_profiles SET status = ''approved'', approved_at = now() WHERE id = v_dp.id;
',
'

  -- 00691: the bonus, after the status change, whose triggers created the tricicoin wallet. It never
  -- raises: a payment that fails leaves the approval as it is and says so in "bonus".
  IF v_first THEN
    v_bonus := public._pay_driver_approval_bonus(v_dp.id, v_me);
    IF v_bonus ->> ''status'' = ''paid'' THEN
      v_body := ''¡Tu cuenta de conductor ha sido aprobada! Te acreditamos '' || (v_bonus ->> ''amount_cup'')
                || '' CUP de bono. Ya puedes recibir viajes.'';
    END IF;
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
',
'          jsonb_build_object(''status'', v_dp.status),
          jsonb_build_object(''status'', p_status)
            || CASE WHEN v_bonus IS NULL THEN ''{}''::jsonb ELSE jsonb_build_object(''bonus'', v_bonus) END,
          v_reason);
',
'  RETURN jsonb_build_object(''success'', true, ''status'', p_status, ''previous_status'', v_dp.status,
                            ''bonus'', v_bonus);
'];

  v_def := pg_get_functiondef(c_fn);
  FOR i IN 1 .. array_length(v_from, 1) LOOP
    v_piece := replace(v_from[i], chr(13), '');
    IF (length(v_def) - length(replace(v_def, v_piece, ''))) / length(v_piece) <> 1 THEN
      RAISE EXCEPTION '00691: piece % of ops_set_driver_status does not appear exactly once', i;
    END IF;
    v_def := replace(v_def, v_piece, replace(v_to[i], chr(13), ''));
  END LOOP;
  EXECUTE v_def;

  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = c_fn;
  IF v_md5 IS DISTINCT FROM c_new THEN
    RAISE EXCEPTION '00691: the patched ops_set_driver_status has md5 %, expected %', v_md5, c_new;
  END IF;
END
$patch$;

-- ── 4. Drivers approved before this ─────────────────────────
-- They got the bonus by hand (all but one, approved on 2026-07-12). Their first approval is already
-- recorded, so the approval never pays them; claiming their phone also keeps a new account with the
-- same phone from getting it. People whose bonus was taken back when their driver profile was
-- deleted were never approved again: their phone stays free and their first approval pays them.
DO $claims$
DECLARE
  v_user uuid;
  v_out text;
  v_claimed integer := 0;
  v_taken integer := 0;
  v_no_phone integer := 0;
BEGIN
  FOR v_user IN
    SELECT DISTINCT dp.user_id
      FROM public.driver_profiles dp
      JOIN public.driver_first_approvals fa ON fa.driver_profile_id = dp.id
     WHERE dp.user_id IS NOT NULL
     ORDER BY dp.user_id
  LOOP
    v_out := public._claim_reward(v_user, 'driver_approval_bonus', NULL, NULL);
    IF v_out = 'claimed' THEN
      v_claimed := v_claimed + 1;
    ELSIF v_out = 'taken' THEN
      v_taken := v_taken + 1;
    ELSE
      v_no_phone := v_no_phone + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '00691: approved drivers: % phones claimed, % already claimed, % without a confirmed phone',
    v_claimed, v_taken, v_no_phone;
END
$claims$;

-- ── 5. Carriage returns ─────────────────────────────────────
-- Pasted from Windows, the SQL Editor puts carriage returns inside the new body: recreate it without
-- them. The patched body is built from pg_get_functiondef and pieces without them.
DO $crlf$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public._pay_driver_approval_bonus(uuid,uuid)'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- ── 6. Checks ───────────────────────────────────────────────
DO $check$
DECLARE
  c_pay constant regprocedure := 'public._pay_driver_approval_bonus(uuid,uuid)'::regprocedure;
  c_ops constant regprocedure := 'public.ops_set_driver_status(uuid,text,text,text)'::regprocedure;
  v_row record;
  v_n integer;
BEGIN
  -- The two bodies, without carriage returns, SECURITY DEFINER with their search_path.
  FOR v_row IN
    SELECT f.fn, f.want, md5(p.prosrc) AS got, position(chr(13) IN p.prosrc) > 0 AS has_cr,
           p.prosecdef, p.proconfig
    FROM (VALUES (c_pay, '26d54b40b6770e5cb2269fd32d522878'), (c_ops, '13154cbfcbcd4e63000d19aec08f07f1')) AS f(fn, want)
    JOIN pg_proc p ON p.oid = f.fn
  LOOP
    IF v_row.got IS DISTINCT FROM v_row.want OR v_row.has_cr THEN
      RAISE EXCEPTION '00691 check: % has md5 %, expected %', v_row.fn, v_row.got, v_row.want;
    END IF;
    IF NOT v_row.prosecdef OR v_row.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
      RAISE EXCEPTION '00691 check: % is not SECURITY DEFINER with its search_path', v_row.fn;
    END IF;
  END LOOP;

  -- Only its owner runs the payment. The approval keeps its grants: signed-in users, never anon.
  IF has_function_privilege('anon', c_pay, 'EXECUTE')
     OR has_function_privilege('authenticated', c_pay, 'EXECUTE')
     OR has_function_privilege('service_role', c_pay, 'EXECUTE') THEN
    RAISE EXCEPTION '00691 check: _pay_driver_approval_bonus is open to clients';
  END IF;
  IF has_function_privilege('anon', c_ops, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', c_ops, 'EXECUTE') THEN
    RAISE EXCEPTION '00691 check: ops_set_driver_status has the wrong grants';
  END IF;

  -- Only the approval calls the payment, and the payment never asks who calls: it moves money, and
  -- the operator checks stay out of money functions (00668).
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.prosrc ~* '_pay_driver_approval_bonus[[:space:]]*[(]' AND p.oid NOT IN (c_ops::oid, c_pay::oid);
  IF v_n > 0 THEN
    RAISE EXCEPTION '00691 check: % other function(s) call _pay_driver_approval_bonus', v_n;
  END IF;
  IF (SELECT p.prosrc ~* '(is_operator|is_ops_staff|is_admin)[[:space:]]*[(]' FROM pg_proc p WHERE p.oid = c_pay) THEN
    RAISE EXCEPTION '00691 check: _pay_driver_approval_bonus asks who calls';
  END IF;

  -- The amount is set, and the first approval is still recorded by its trigger (the approval reads it).
  IF NOT EXISTS (SELECT 1 FROM public.platform_config pc WHERE pc.key = 'driver_approval_bonus_cup') THEN
    RAISE EXCEPTION '00691 check: platform_config.driver_approval_bonus_cup is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.driver_profiles'::regclass
                    AND t.tgname = 'trg_driver_profiles_first_approval' AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '00691 check: trg_driver_profiles_first_approval is missing or disabled';
  END IF;

  -- Every driver approved so far with a confirmed phone has it claimed.
  SELECT count(*) INTO v_n
    FROM (SELECT DISTINCT dp.user_id
            FROM public.driver_profiles dp
            JOIN public.driver_first_approvals fa ON fa.driver_profile_id = dp.id
           WHERE dp.user_id IS NOT NULL) a
   WHERE public._reward_claim_status(a.user_id, 'driver_approval_bonus') = 'free';
  IF v_n > 0 THEN
    RAISE EXCEPTION '00691 check: % approved driver(s) with a confirmed phone have no claim', v_n;
  END IF;
END
$check$;
$mig$;
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
