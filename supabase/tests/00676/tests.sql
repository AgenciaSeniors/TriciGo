-- Behaviour tests of 00676, for one session. run.sh loads this file; the cases that need two
-- sessions at once live there.
--
-- t.case(name, expected, steps...) runs the steps in order and rolls all of them back. A step that
-- starts with SELECT or WITH prints its first column, and the printed values are joined with ';'.
-- '@{ana}' acts as that user through PostgREST (role authenticated, with a JWT subject), '@anon'
-- and '@service' as those roles with no JWT, and '@db' goes back to the superuser with no JWT, which
-- is how GoTrue, the cron and a migration write. {name} stands for an id of t.ids. An expected value
-- that starts with 'ERROR ' asks for that SQLSTATE instead of a value.
CREATE SCHEMA IF NOT EXISTS t;
GRANT USAGE ON SCHEMA t TO PUBLIC;

CREATE TABLE t.ids (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO t.ids VALUES
  ('ana',  'a6760000-0000-4000-8000-000000000001'), ('beto', 'a6760000-0000-4000-8000-000000000002'),
  ('olga', 'a6760000-0000-4000-8000-000000000003'), ('eva',  'a6760000-0000-4000-8000-000000000004'),
  ('pepe', 'a6760000-0000-4000-8000-000000000005'), ('dora', 'a6760000-0000-4000-8000-000000000006'),
  ('rafa', 'a6760000-0000-4000-8000-000000000007'), ('nico', 'a6760000-0000-4000-8000-000000000008'),
  ('xavi', 'a6760000-0000-4000-8000-000000000009'),
  ('cap',  'c6760000-0000-4000-8000-00000000000a'), ('caa',  'c6760000-0000-4000-8000-00000000000b'),
  ('cac',  'c6760000-0000-4000-8000-00000000000c'), ('ca2',  'c6760000-0000-4000-8000-00000000000d'),
  ('dfp',  'd6760000-0000-4000-8000-00000000000a'), ('dfa',  'd6760000-0000-4000-8000-00000000000b'),
  ('df2',  'd6760000-0000-4000-8000-00000000000d'),
  ('pa1',  'f6760000-0000-4000-8000-0000000000a1'), ('pa2',  'f6760000-0000-4000-8000-0000000000a2'),
  ('pa3',  'f6760000-0000-4000-8000-0000000000a3'),
  ('b1',   'f6760000-0000-4000-8000-0000000000b1'), ('b2',   'f6760000-0000-4000-8000-0000000000b2'),
  ('b3',   'f6760000-0000-4000-8000-0000000000b3'), ('b4',   'f6760000-0000-4000-8000-0000000000b4'),
  ('b5',   'f6760000-0000-4000-8000-0000000000b5'), ('b6',   'f6760000-0000-4000-8000-0000000000b6'),
  ('b7',   'f6760000-0000-4000-8000-0000000000b7'), ('b8',   'f6760000-0000-4000-8000-0000000000b8'),
  ('b9',   'f6760000-0000-4000-8000-0000000000b9'),
  ('new',  'e6760000-0000-4000-8000-000000000001'), ('new2', 'e6760000-0000-4000-8000-000000000002'),
  ('acct', 'e6760000-0000-4000-8000-000000000011'),
  ('gone', '00000000-0000-0000-0000-000000000099');

CREATE VIEW t.sms AS
  SELECT q.id, q.url, q.headers, q.body ->> 'phone' AS phone, q.body ->> 'body' AS text,
         q.body ->> 'user_id' AS user_id, q.body ->> 'event_type' AS event_type, q.body -> 'gsm7' AS gsm7
  FROM net.http_request_queue q JOIN public.cron_http_calls c ON c.request_id = q.id
  WHERE c.jobname = 'fleet-invite-sms';
CREATE VIEW t.push AS
  SELECT q.id, q.body -> 'user_ids' ->> 0 AS user_id, q.body ->> 'title' AS title, q.body ->> 'body' AS text,
         q.body -> 'data' ->> 'type' AS type, q.body -> 'data' ->> 'event' AS event, q.body AS raw
  FROM net.http_request_queue q JOIN public.cron_http_calls c ON c.request_id = q.id
  WHERE c.jobname = 'ops-driver-review';

-- Who was pushed what, in order: event>person.
CREATE FUNCTION t.pushes() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(string_agg(p.event || '>' || COALESCE(i.name, p.user_id), ',' ORDER BY p.id), 'none')
  FROM t.push p LEFT JOIN t.ids i ON i.id::text = p.user_id
$f$;
-- What the ledger of a fleet says, in order: channel:source.
CREATE FUNCTION t.sends(p_fleet uuid) RETURNS text LANGUAGE plpgsql STABLE AS $f$
DECLARE v text;
BEGIN
  SELECT COALESCE(string_agg(s.channel || ':' || s.source, ',' ORDER BY s.id), 'none') INTO v
  FROM public.fleet_invite_sends s WHERE s.fleet_id = p_fleet;
  RETURN v;
END $f$;
-- Only GSM-7 characters, none of them from the extension table (those count double).
CREATE FUNCTION t.gsm7(p_text text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
  SELECT p_text ~ '^[A-Za-z0-9 .,:/''Ññé-]+$'
$f$;
-- What was logged, in order: rpc:outcome.
CREATE FUNCTION t.log() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(string_agg(rpc_name || ':' || outcome, ',' ORDER BY id), 'none') FROM public.rpc_attempt_log
$f$;

CREATE FUNCTION t.case(p_name text, p_expected text, VARIADIC p_steps text[])
 RETURNS text
 LANGUAGE plpgsql
AS $f$
DECLARE
  v_steps text[] := p_steps;
  v_id    record;
  v_i     integer;
  v_step  text;
  v_val   text;
  v_got   text;
  v_error text;
BEGIN
  FOR v_id IN SELECT name, id FROM t.ids LOOP
    FOR v_i IN 1 .. cardinality(v_steps) LOOP
      v_steps[v_i] := replace(v_steps[v_i], '{' || v_id.name || '}', v_id.id::text);
    END LOOP;
  END LOOP;

  BEGIN
    FOREACH v_step IN ARRAY v_steps LOOP
      IF v_step = '@db' THEN
        RESET ROLE;
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSIF v_step = '@anon' THEN
        PERFORM set_config('request.jwt.claim.sub', '', true);
        SET LOCAL ROLE anon;
      ELSIF v_step = '@service' THEN
        PERFORM set_config('request.jwt.claim.sub', '', true);
        SET LOCAL ROLE service_role;
      ELSIF v_step LIKE '@%' THEN
        PERFORM set_config('request.jwt.claim.sub', substr(v_step, 2), true);
        SET LOCAL ROLE authenticated;
      ELSIF v_step ~* '^\s*(select|with)\M' THEN
        EXECUTE v_step INTO v_val;
        v_got := concat_ws(';', v_got, COALESCE(v_val, '<null>'));
      ELSE
        EXECUTE v_step;
      END IF;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'TR000';
  EXCEPTION
    WHEN SQLSTATE 'TR000' THEN NULL;
    WHEN OTHERS THEN v_error := 'ERROR ' || SQLSTATE || ' ' || SQLERRM;
  END;

  IF p_expected LIKE 'ERROR %' THEN
    IF v_error LIKE p_expected || '%' THEN
      RETURN 'PASS  ' || p_name;
    END IF;
  ELSIF v_error IS NULL AND v_got IS NOT DISTINCT FROM p_expected THEN
    RETURN 'PASS  ' || p_name;
  END IF;
  RETURN 'FAIL  ' || p_name || '  -- expected [' || p_expected || '], got ['
         || COALESCE(v_error, COALESCE(v_got, '<nothing printed>')) || ']';
END
$f$;

-- ── S. The scaffold is prod ──────────────────────────────────
-- md5 and length of each body, read from prod on 2026-11-06. The migration changes none of them, so
-- run after it this also says nothing else moved.
SELECT t.case('S0 every function these paths run has prod''s body', 'same',
  $$SELECT COALESCE(string_agg(f.fn, ', '), 'same')
    FROM (VALUES
      ('auth.uid()', 'cdef18c69c4f4cbbced2eaf81e628b49/176'),
      ('public._normalize_cuban_phone(text)', '9f5227a3c108fa42f6aacdf01fb0ad86/451'),
      ('public._ops_acting_on(uuid)', '3fb1b0523206ef664115ce6be52cac17/366'),
      ('public._ops_allow(uuid[])', '4762cf93cce4a747dc420cf3cdd7c7e9/250'),
      ('public._ops_user_push(text,uuid,uuid,text,text,jsonb)', '73fd48ad4447f90a308e463ee03617ad/1215'),
      ('public._third_party_person_name(text)', '5cf3955820fc9db845f8831fb791fc22/552'),
      ('public._user_id_by_verified_phone(text)', 'c9799dafa968fe353f595a3eed778541/575'),
      ('public.auto_link_fleet_member_on_phone_confirmed()', '725cc133ec484ffab33129205b1b6988/1574'),
      ('public.auto_link_fleet_member_on_signup()', '4903103e8e8c044e7d9d5cae68da1f3b/1301'),
      ('public.corp_has_no_employees(uuid)', '6eb4d06d1ab898c5f21b6696f2ff3b6e/108'),
      ('public.corp_is_creator(uuid)', '99d6a94b15f342f57f49000ccec4d2d2/117'),
      ('public.cron_http_post(text,text,jsonb,jsonb,integer)', '15d9ded451c60f92a0fd0a3c4e1ee0ab/626'),
      ('public.current_user_role()', 'cb4a7c12d4e21fe2997135833f141e25/103'),
      ('public.get_service_role_key()', 'a0b1b63fcf1499ffb407a5718826b02c/205'),
      ('public.handle_new_user()', 'c42fa89f6155a50a1cc4198255dd9d77/299'),
      ('public.is_admin()', '22cb75e91980d512498034cd33e1eda2/285'),
      ('public.is_corp_admin(uuid)', '18fddc29b4046e10ff1c2a8030c58ab0/195'),
      ('public.is_marketing()', '1903156b6a1218a543888ae2ebfb3656/291'),
      ('public.is_operator()', '16438eb527af61eaa2d0b3d9a53f08f9/292'),
      ('public.is_ops_staff()', 'd6774e4677be1072e66b247492e9cb9a/268'),
      ('public.log_rpc_attempt(text,uuid,uuid,text,jsonb)', '0a902c34a1148dac5686403a7c941bc0/203'),
      ('public.ops_review_fleet_account(uuid,text,text,text)', '57913ebd47abeea8baef0cc252a29a58/2235'),
      ('public.ops_review_fleet_member(uuid,text,jsonb,text)', '49898a2b2a042f4dc37de28d89119b13/2545'),
      ('public.relink_fleet_member_for_existing_driver(uuid,text)', '87327e7eb782781d445804ae8b4a5a21/565'),
      ('public.tg_corporate_accounts_protect_admin_fields()', 'a8263f1d55d0af6ade45d972b21e6800/1479'),
      ('public.tg_corporate_accounts_protect_insert()', '16d3e41267fd99172c562f62e4e968fd/455'),
      ('public.tg_corporate_employees_protect_creator()', '61ee78d1a57cb9cefa8de5965923f857/693'),
      ('public.tg_driver_fleets_protect()', '8ba548f4638ca9c1f8fcb8899a942890/391'),
      ('public.tg_fleet_members_protect()', '9604aabd771340db647705c0cba33d58/1512'),
      ('public.tg_fleet_members_set_driver_on_approval()', 'e04640ae43a47d6de37a2095cce1dbc5/705'),
      ('public.trg_driver_fleets_updated_at()', '301a884953d37769916294bb60562e05/52'),
      ('public.update_updated_at_column()', 'e7a0919a4073eaabf72630cc53a76237/48')
    ) AS f(fn, want)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.fn)
    WHERE p.oid IS NULL OR md5(p.prosrc) || '/' || length(p.prosrc) <> f.want$$);

-- ── A. Who approves first: exactly one first contact ─────────
SELECT t.case('A1 driver first, company second: the SMS waits for the company', '0;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A2 company first, driver second: one SMS at the driver''s approval', '0;1',
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A3 through the panel, driver first: one SMS, in the ledger as review', 'approved;approved;1;sms:review',
  '@{olga}',
  $$SELECT public.ops_review_fleet_member('{pa1}', 'approved', (SELECT to_jsonb(m) FROM public.fleet_members m WHERE m.id = '{pa1}')) ->> 'status'$$,
  $$SELECT public.ops_review_fleet_account('{cap}', 'approved', 'pending') ->> 'status'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfp}')$$);
SELECT t.case('A4 through the panel, company first: one SMS', 'approved;approved;1',
  '@{olga}',
  $$SELECT public.ops_review_fleet_account('{cap}', 'approved', 'pending') ->> 'status'$$,
  $$SELECT public.ops_review_fleet_member('{pa1}', 'approved', (SELECT to_jsonb(m) FROM public.fleet_members m WHERE m.id = '{pa1}')) ->> 'status'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A5 suspending and approving the company again sends nothing new', '1;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A6 a rejected or suspended company contacts nobody', '0;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'rejected' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A7 pending_signup counts as approved', 'pending_signup;1',
  $$UPDATE public.fleet_members SET status = 'pending_signup' WHERE id = '{b1}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A8 the company approval announces a pending_signup row too', '1',
  $$UPDATE public.fleet_members SET status = 'pending_signup' WHERE id = '{pa1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A9 asking again finds the first contact and sends nothing', 'already_contacted;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT public._fleet_announce_member('{b1}', 'review')$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A10 one number in two spellings in a fleet: one SMS, under the normalized number', '1;+5355530008;+5355530008',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b8}', '{b9}')$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT phone FROM t.sms$$,
  $$SELECT string_agg(DISTINCT phone, ',') FROM public.fleet_invite_sends$$);
SELECT t.case('A11 the same, when the company approval finds both', '1',
  $$INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES
      ('{dfp}', 'Una', '55540001', 'approved'), ('{dfp}', 'Otra', '+5355540001', 'approved')$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A12 the company approval contacts each approved member once, each by its channel', '2;sms:review,sms:review,push:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{pa1}', '{pa2}', '{pa3}')$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfp}')$$);
SELECT t.case('A13 a member still in review is not contacted', '0;none',
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfp}')$$);
SELECT t.case('A14 the announce states why it did not send', 'company_not_approved;not_invitable;not_found',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$SELECT public._fleet_announce_member('{pa1}', 'review')$$,
  $$SELECT public._fleet_announce_member('{b1}', 'review')$$,
  $$SELECT public._fleet_announce_member('{new}', 'review')$$);
SELECT t.case('A15 a passenger who got the SMS and became a driver hears nothing when the company is approved again', 'sms:review;sms:review;none',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  $$INSERT INTO public.driver_profiles (user_id, status) VALUES ('{pepe}', 'approved')$$,
  $$SELECT t.sends('{dfa}')$$,
  $$DELETE FROM public.cron_http_calls$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT COALESCE(string_agg(event, ','), 'none') FROM t.push WHERE user_id = '{pepe}'$$);
SELECT t.case('A16 a driver who got the push and was then suspended gets no SMS when the company is approved again', 'push:review;push:review;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$UPDATE public.driver_profiles SET status = 'suspended' WHERE user_id = '{dora}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A17 nor one who deleted their account, with the reference moved to the anonymous user', 'push:review;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$INSERT INTO auth.users (id) VALUES ('{gone}')$$,
  $$UPDATE public.fleet_members SET driver_id = '{gone}' WHERE id = '{b3}'$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('A18 a linked invitation that lost its first contact has no resend, and gets it when the company is approved again', 'not_invitable;sms:review',
  $$SET LOCAL test.http_fail = 'send-sms'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  $$SET LOCAL test.http_fail = ''$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b2}') ->> 'error'$$,
  '@db',
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT t.sends('{dfa}')$$);

-- ── B. Someone who already confirmed that number ─────────────
SELECT t.case('B1 a passenger who confirmed the number is linked at approval and still gets the SMS', 'active:true;1;+5355510005;pepe;sms:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  $$SELECT status || ':' || (driver_id = '{pepe}') FROM public.fleet_members WHERE id = '{b2}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT phone FROM t.sms$$,
  $$SELECT i.name FROM t.sms s JOIN t.ids i ON i.id::text = s.user_id$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('B2 so does a driver still in review', 'active;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b4}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b4}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('B3 an approved driver gets a push and no SMS', 'active;0;member_linked>beto,added_to_fleet>dora;push:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.pushes()$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('B4 a number confirmed before the company is approved: linked, and the SMS waits for the company', 'active;0;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$INSERT INTO auth.users (id, phone) VALUES ('{acct}', '5355520001')$$,
  $$UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '{acct}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{pa1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('B5 the driver who signs up after the SMS is not contacted again', '1;active;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$INSERT INTO auth.users (id, phone) VALUES ('{acct}', '5355530001')$$,
  $$UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '{acct}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('B6 the push routes in the apps: data.type survives, no category is sent', 'fleet_update;added_to_fleet;false',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SELECT type FROM t.push WHERE event = 'added_to_fleet'$$,
  $$SELECT event FROM t.push WHERE user_id = '{dora}'$$,
  $$SELECT bool_or(raw ? 'category') FROM t.push$$);

-- ── C. A notice that fails stops nothing ─────────────────────
SELECT t.case('C1 the SMS call fails: the approval stands, no row, logged, and the owner can resend at once',
  'approved;none;0;_fleet_announce_member:announce_failed;true;1',
  $$SET LOCAL test.http_fail = 'send-sms'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.log()$$,
  $$SET LOCAL test.http_fail = ''$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('C2 the company approval survives it too, and the other members still go out', 'approved;1;_fleet_announce_member:announce_failed',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{pa1}', '{pa3}')$$,
  $$SET LOCAL test.http_fail = 'send-sms'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT status FROM public.corporate_accounts WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  $$SELECT t.log()$$);
SELECT t.case('C3 no service key: no row, logged, the approval stands', 'approved;none;_fleet_announce_member:no_service_key',
  $$UPDATE vault.decrypted_secrets SET decrypted_secret = NULL$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT t.log()$$);
SELECT t.case('C4 a push that raises leaves no row, and the approval stands', 'active;none;_fleet_push:push_failed,_fleet_announce_member:announce_failed',
  $$ALTER TABLE public.notification_preferences RENAME TO np_gone$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT t.log()$$);
SELECT t.case('C5 a failing push does not take the SMS down with it', 'active;1;_fleet_push:push_failed',
  $$ALTER TABLE public.notification_preferences RENAME TO np_gone$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b2}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.log()$$);
SELECT t.case('C6 confirming the phone, as GoTrue does: the login and the link stand when the push fails',
  'true;active;_fleet_push:push_failed',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$ALTER TABLE public.notification_preferences RENAME TO np_gone$$,
  $$INSERT INTO auth.users (id, phone) VALUES ('{acct}', '5355530001')$$,
  $$UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '{acct}'$$,
  $$SELECT phone_confirmed_at IS NOT NULL FROM auth.users WHERE id = '{acct}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.log()$$);
SELECT t.case('C7 the same at signup, with the number already confirmed', 'active;_fleet_push:push_failed',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$ALTER TABLE public.notification_preferences RENAME TO np_gone$$,
  $$INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('{acct}', '5355530001', now())$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.log()$$);
SELECT t.case('C8 the member trigger cannot read: the write stands, logged', 'rejected;tg_fleet_members_notify:notify_failed',
  $$ALTER TABLE public.users RENAME TO users_gone$$,
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{b1}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.log()$$);
SELECT t.case('C9 the company trigger cannot read: the write stands, logged', 'approved;tg_corporate_accounts_fleet_notify:notify_failed',
  $$ALTER TABLE public.driver_fleets RENAME TO fleets_gone$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT status FROM public.corporate_accounts WHERE id = '{cap}'$$,
  $$SELECT t.log()$$);
SELECT t.case('C10 the push call fails: the rejection stands, logged by the push itself', 'rejected;none;_fleet_push:push_failed',
  $$SET LOCAL test.http_fail = 'send-push'$$,
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{b1}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT t.log()$$);
SELECT t.case('C11 a delete stands when its push fails', '0;_fleet_push:push_failed',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$ALTER TABLE public.notification_preferences RENAME TO np_gone$$,
  $$DELETE FROM public.rpc_attempt_log$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT count(*) FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT t.log()$$);
SELECT t.case('C12 a push whose call fails keeps its row: _ops_user_push catches that and logs it', 'active;push:review;_fleet_push:push_failed,_fleet_announce_member:push_failed',
  $$SET LOCAL test.http_fail = 'send-push'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT t.log()$$);

-- ── D. Deleting and adding again resets nothing ──────────────
SELECT t.case('D1 no second SMS for the same number in the same fleet', '1;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Quique Otra Vez', '+5355530001')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('D2 not with the number in another spelling either', '1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Quique Otra Vez', '55530001')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('D3 the 24 hours still run after deleting and adding again', 'too_soon;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Quique Otra Vez', '+5355530001')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{new}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('D4 so do the three sends', 'limit_reached;3',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source, sent_at)
    SELECT '{dfa}', '+5355530001', '{b1}', 'sms', 'resend', now() - interval '3 days' FROM generate_series(1, 2)$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = now() - interval '3 days'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Quique Otra Vez', '+5355530001')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{new}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM public.fleet_invite_sends$$);
SELECT t.case('D5 another fleet counts on its own', '2;sms:review;sms:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b2}', '{pa2}')$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT t.sends('{dfp}')$$);
SELECT t.case('D6 a driver who left and is invited again is told again: one push per invitation', 'true;push:review,push:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$DELETE FROM public.fleet_members WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Dora Vega', '+5355510006')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('D7 one invitation gets one push, however it is asked', 'already_contacted;push:review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SELECT public._fleet_announce_member('{b3}', 'review')$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('D8 the ledger outlives the invitation: member_id is no foreign key', 'sms:review;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT count(*) FROM public.fleet_invite_sends WHERE member_id = '{b1}'$$);
SELECT t.case('D9 a resend counts as contact: approving the company again sends no review SMS on top', 'true;1;sms:resend',
  $$SET LOCAL test.http_fail = 'send-sms'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SET LOCAL test.http_fail = ''$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{caa}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('D10 a resend counts for a new invitation of the number too', 'true;1',
  $$SET LOCAL test.http_fail = 'send-sms'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SET LOCAL test.http_fail = ''$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$DELETE FROM public.fleet_members WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Quique Otra Vez', '+5355530001')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  $$SELECT count(*) FROM t.sms$$);

-- ── E. What the SMS and the driver's push say ────────────────
SELECT t.case('E1 with the owner''s name',
  'TriciGo: Ana M. te espera en su flota de conductores. Baja la app TriciGo Conductor y entra con este teléfono: https://tricigo.com/conductores',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT text FROM t.sms$$);
SELECT t.case('E2 an owner with no name',
  'TriciGo: una flota te espera como conductor. Baja la app TriciGo Conductor y entra con este teléfono: https://tricigo.com/conductores',
  $$UPDATE public.users SET full_name = '' WHERE id = '{ana}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT text FROM t.sms$$);
SELECT t.case('E3 accents off, ñ kept', 'Jose Ñ.;maria A.;Zoe',
  $$SELECT substr(split_part(public._fleet_invite_sms_text('José Ñúñez Peña'), ' te espera', 1), 10)$$,
  $$SELECT substr(split_part(public._fleet_invite_sms_text('maría ángel'), ' te espera', 1), 10)$$,
  $$SELECT substr(split_part(public._fleet_invite_sms_text('Zoë'), ' te espera', 1), 10)$$);
SELECT t.case('E4 what is left outside GSM-7 falls back to the text with no name', 'true;true;true;true',
  $$SELECT public._fleet_invite_sms_text('Søren Ørsted') = public._fleet_invite_sms_text('')$$,
  $$SELECT public._fleet_invite_sms_text('Æther Gil') = public._fleet_invite_sms_text(NULL)$$,
  $$SELECT public._fleet_invite_sms_text('ÞÐ') = public._fleet_invite_sms_text('')$$,
  $$SELECT public._fleet_invite_sms_text('12345 !!') = public._fleet_invite_sms_text('')$$);
SELECT t.case('E5 the longest names fit one part: 159 characters, all of them GSM-7', '159;true;159;true',
  $$SELECT length(public._fleet_invite_sms_text('Ñáéíóúñáéíóúñáéíóúñáéíóú Ángel'))$$,
  $$SELECT t.gsm7(public._fleet_invite_sms_text('Ñáéíóúñáéíóúñáéíóúñáéíóú Ángel'))$$,
  $$SELECT length(public._fleet_invite_sms_text('María-José-de-la-Concepción-Fernández O''Brien'))$$,
  $$SELECT t.gsm7(public._fleet_invite_sms_text('María-José-de-la-Concepción-Fernández O''Brien'))$$);
SELECT t.case('E6 the text with no name is one part too', '133;true',
  $$SELECT length(public._fleet_invite_sms_text(''))$$,
  $$SELECT t.gsm7(public._fleet_invite_sms_text(''))$$);
SELECT t.case('E7 a name cannot carry a link', 'TriciGo: wwwevilcom J. te espera',
  $$SELECT left(public._fleet_invite_sms_text('www.evil.com Juan http://x.y'), 32)$$);
SELECT t.case('E8 nothing the owner typed reaches the SMS: no fleet, no company, no driver name', '1;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT count(*) FROM t.sms WHERE text ~ '(SECRETA|Pablo)'$$);
SELECT t.case('E9 nor the pushes to the driver, added or removed', '2;0;Ana M. te agregó a su flota. Si no quieres estar en ella, puedes salir desde Corporativo.;Ana M. te quitó de su flota.',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa3}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{pa3}'$$,
  $$SELECT count(*) FROM t.push WHERE user_id = '{dora}'$$,
  $$SELECT count(*) FROM t.push WHERE user_id = '{dora}' AND (title || ' ' || text) ~ 'SECRETA'$$,
  $$SELECT text FROM t.push WHERE event = 'added_to_fleet'$$,
  $$SELECT text FROM t.push WHERE event = 'removed_from_fleet'$$);
SELECT t.case('E10 the driver''s pushes with an owner with no name', 'Ahora eres parte de una flota. Si no quieres estar en ella, puedes salir desde Corporativo.;Te quitaron de una flota.',
  $$UPDATE public.users SET full_name = '' WHERE id = '{ana}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa3}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$DELETE FROM public.fleet_members WHERE id = '{pa3}'$$,
  $$SELECT text FROM t.push WHERE event = 'added_to_fleet'$$,
  $$SELECT text FROM t.push WHERE event = 'removed_from_fleet'$$);
SELECT t.case('E11 the call is what send-sms expects, through cron_http_post',
  'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms;test-service-key;Bearer test-service-key;fleet_invite;<null>;true',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT url FROM t.sms$$,
  $$SELECT headers ->> 'apikey' FROM t.sms$$,
  $$SELECT headers ->> 'Authorization' FROM t.sms$$,
  $$SELECT event_type FROM t.sms$$,
  $$SELECT user_id FROM t.sms$$,
  $$SELECT gsm7 FROM t.sms$$);
SELECT t.case('E12 every SMS asks send-sms for GSM-7 with a JSON true, the resend too', 'true;2;2',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT count(*) FROM t.sms WHERE gsm7 = 'true'::jsonb$$);

-- ── F. Resending ─────────────────────────────────────────────
SELECT t.case('F1 after 24 hours the owner resends', 'true;2;sms:review,sms:resend',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '24 hours 1 minute'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('F2 before 24 hours: too_soon, with when it opens, and nothing sent', 'too_soon;true;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '23 hours 59 minutes'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  $$SELECT (public.resend_fleet_invite('{b1}') ->> 'retry_at')::timestamptz > now()$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F3 the fourth is limit_reached', 'true;true;limit_reached;3',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F4 nobody else can resend: not another owner, a stranger, the driver or the staff', 'forbidden;forbidden;forbidden;forbidden;forbidden;forbidden;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{ana}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@{nico}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@{pepe}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@{olga}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@{eva}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@service',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F5 an invitation that does not exist', 'not_found',
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{new}') ->> 'error'$$);
SELECT t.case('F6 not invitable: in review, rejected, inactive, already linked', 'not_invitable;not_invitable;not_invitable;not_invitable',
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{b4}'$$,
  $$UPDATE public.fleet_members SET status = 'inactive' WHERE id = '{b7}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  $$SELECT public.resend_fleet_invite('{b4}') ->> 'error'$$,
  $$SELECT public.resend_fleet_invite('{b7}') ->> 'error'$$,
  $$SELECT public.resend_fleet_invite('{b2}') ->> 'error'$$);
SELECT t.case('F7 nor while the company is not approved: nothing was sent, so nothing is resent', 'not_invitable;0;not_invitable;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{pa1}'$$,
  '@{ana}',
  $$SELECT public.resend_fleet_invite('{pa1}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{cap}'$$,
  '@{ana}',
  $$SELECT public.resend_fleet_invite('{pa1}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F8 pending_signup resends like approved', 'true;sms:review,sms:resend',
  $$UPDATE public.fleet_members SET status = 'pending_signup' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$SELECT t.sends('{dfa}')$$);
SELECT t.case('F9 thirty resends a day per owner, across their fleets, then limit_reached', 'limit_reached;true',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  $$INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by) VALUES ('{ca2}', 'Segunda', '+5355590002', 'approved', '{beto}')$$,
  $$INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('{df2}', '{ca2}', 'Segunda')$$,
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT CASE WHEN g % 2 = 0 THEN '{dfa}'::uuid ELSE '{df2}'::uuid END, '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'resend'
    FROM generate_series(1, 30) g$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@db',
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours' WHERE source = 'resend'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$);
SELECT t.case('F10 twenty-nine still leave room', 'true',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfa}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'resend' FROM generate_series(1, 29) g$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$);
SELECT t.case('F11 another owner''s resends do not count', 'true',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'resend' FROM generate_series(1, 30) g$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$);
SELECT t.case('F12 two hundred SMS a day in total: the first contact waits, logged', '0;none;_fleet_announce_member:daily_cap',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'review' FROM generate_series(1, 200) g$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT t.log()$$);
SELECT t.case('F13 a resend then answers limit_reached, and once the day has passed it goes out', 'limit_reached;0;true;1',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'review' FROM generate_series(1, 200) g$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'error'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$,
  $$UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b1}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F14 pushes cost nothing and do not count', '1',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'push', 'review' FROM generate_series(1, 200) g$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F15 nor does a day-old SMS', '1',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source, sent_at)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'review', now() - interval '25 hours' FROM generate_series(1, 200) g$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
SELECT t.case('F16 one hundred ninety-nine still leave room', '1',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source)
    SELECT '{dfp}', '+535555' || lpad(g::text, 4, '0'), gen_random_uuid(), 'sms', 'review' FROM generate_series(1, 199) g$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);

-- ── G. Only Cuban mobiles get an SMS ─────────────────────────
SELECT t.case('G1 a number from outside Cuba sends nothing', 'approved;0;none;not_cuban_mobile',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b6}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b6}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT public._fleet_announce_member('{b6}', 'review')$$);
SELECT t.case('G2 nor a Cuban landline', 'approved;0;not_cuban_mobile',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b7}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b7}'$$,
  $$SELECT count(*) FROM t.sms$$,
  $$SELECT public._fleet_announce_member('{b7}', 'review')$$);
SELECT t.case('G3 they cannot be resent either', 'not_invitable;not_invitable',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b6}', '{b7}')$$,
  '@{beto}',
  $$SELECT public.resend_fleet_invite('{b6}') ->> 'error'$$,
  $$SELECT public.resend_fleet_invite('{b7}') ->> 'error'$$);
SELECT t.case('G4 a 63 or 64 mobile is Cuban', '1',
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('{new}', '{dfa}', 'Nueva Serie', '63012345')$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{new}'$$,
  $$SELECT count(*) FROM t.sms WHERE phone = '+5363012345'$$);
SELECT t.case('G5 an approved driver with a foreign number still gets the push: no SMS is involved', 'push:review;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b5}'$$,
  $$SELECT t.sends('{dfa}')$$,
  $$SELECT count(*) FROM t.sms$$);

-- ── H. Leaving a fleet ───────────────────────────────────────
SELECT t.case('H1 a driver leaves: the row goes inactive and the owner is told', 'true;inactive;member_left>beto',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('H2 not someone else''s row: not another driver, the owner or the staff', 'forbidden;forbidden;forbidden;active',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{pepe}',
  $$SELECT public.leave_fleet('{b3}') ->> 'error'$$,
  '@{beto}',
  $$SELECT public.leave_fleet('{b3}') ->> 'error'$$,
  '@{eva}',
  $$SELECT public.leave_fleet('{b3}') ->> 'error'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$);
SELECT t.case('H3 a row that does not exist', 'not_found',
  '@{dora}',
  $$SELECT public.leave_fleet('{new}') ->> 'error'$$);
SELECT t.case('H4 the trusted flag goes back to what it was, unset', 'true;',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  $$SELECT COALESCE(current_setting('app.trusted_fleet_update', true), '')$$);
SELECT t.case('H5 or set, when a link earlier in the transaction left it set', 'true;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$SET LOCAL app.trusted_fleet_update = '1'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  $$SELECT current_setting('app.trusted_fleet_update', true)$$);
SELECT t.case('H6 once it is restored, the protection is back for the rest of the transaction', 'true;inactive',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@{beto}',
  $$UPDATE public.fleet_members SET status = 'active' WHERE id = '{b3}'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$);
SELECT t.case('H7 a second tap is no error and no second push', 'true;true;1',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.push WHERE event = 'member_left'$$);
SELECT t.case('H8 a rejected row of theirs has nothing to leave', 'not_active;rejected',
  $$UPDATE public.fleet_members SET status = 'rejected', driver_id = '{dora}' WHERE id = '{b1}'$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b1}') ->> 'error'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$);
SELECT t.case('H9 leaving one fleet leaves the other as it was', 'true;inactive;active',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b3}', '{pa3}')$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{pa3}'$$);
SELECT t.case('H10 no session: forbidden', 'forbidden',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@service',
  $$SELECT public.leave_fleet('{b3}') ->> 'error'$$);
SELECT t.case('H11 one number in two spellings: leaving takes both rows out of the fleet', 'true;0;inactive,inactive',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('{new}', '{dfa}', '{dora}', 'Dora Vega', '+5355510006', 'active')$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  $$SELECT count(*) FROM public.get_my_fleet_memberships()$$,
  '@db',
  $$SELECT string_agg(status, ',') FROM public.fleet_members WHERE id IN ('{b3}', '{new}')$$);
SELECT t.case('H12 a rejected row of theirs in that fleet keeps its status', 'true;inactive;rejected',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('{new}', '{dfa}', '{dora}', 'Dora Vega', '+5355510006', 'rejected')$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{new}'$$);
SELECT t.case('H13 a tap on a row that already left takes a twin out too: success means out of the fleet', 'true;0;inactive,inactive',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('{new}', '{dfa}', '{dora}', 'Dora Vega', '+5355510006', 'inactive')$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{new}') ->> 'success'$$,
  $$SELECT count(*) FROM public.get_my_fleet_memberships()$$,
  '@db',
  $$SELECT string_agg(status, ',') FROM public.fleet_members WHERE id IN ('{b3}', '{new}')$$);
SELECT t.case('H14 the owner hears about each row: two rows, two notices', 'true;2',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (id, fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('{new}', '{dfa}', '{dora}', 'Dora Vega', '+5355510006', 'active')$$,
  '@{dora}',
  $$SELECT public.leave_fleet('{b3}') ->> 'success'$$,
  '@db',
  $$SELECT count(*) FROM t.push WHERE event = 'member_left' AND user_id = '{beto}'$$);

-- ── I. What the owner and the driver are told ────────────────
SELECT t.case('I1 the owner hears the fleet was approved', 'fleet_approved>ana;Tu flota fue aprobada',
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT title FROM t.push$$);
SELECT t.case('I2 rejected', 'fleet_rejected>ana;Tu flota no fue aprobada',
  $$UPDATE public.corporate_accounts SET status = 'rejected' WHERE id = '{cap}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT title FROM t.push$$);
SELECT t.case('I3 suspended', 'fleet_suspended>beto;Tu flota fue suspendida',
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT title FROM t.push$$);
SELECT t.case('I4 a corporate client with no fleet hears nothing from this', 'none',
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cac}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I5 a change that is not of status says nothing', 'none',
  $$UPDATE public.corporate_accounts SET name = 'Otro nombre' WHERE id = '{caa}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I6 a driver rejected through the panel: the owner hears it, with the name they typed', 'rejected;member_rejected>beto;TriciGo no aprobó a Quique Uno. Abre la app para ver el motivo.',
  '@{olga}',
  $$SELECT public.ops_review_fleet_member('{b1}', 'rejected', (SELECT to_jsonb(m) FROM public.fleet_members m WHERE m.id = '{b1}'), 'Licencia vencida') ->> 'status'$$,
  '@db',
  $$SELECT t.pushes()$$,
  $$SELECT text FROM t.push$$);
SELECT t.case('I7 linked at approval: the BEFORE trigger sets driver_id, and this still fires', 'member_linked>beto;Pepe Luna ya está en tu flota.',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b2}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT text FROM t.push$$);
SELECT t.case('I8 linked when the account confirms the number, as GoTrue does it', 'none;active;member_linked>beto',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b6}'$$,
  $$INSERT INTO auth.users (id, phone) VALUES ('{acct}', '13055550199')$$,
  $$SELECT t.pushes()$$,
  $$UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '{acct}'$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b6}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I9 linked at signup with the number already confirmed', 'active;member_linked>beto',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b6}'$$,
  $$INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('{acct}', '13055550199', now())$$,
  $$SELECT status FROM public.fleet_members WHERE id = '{b6}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I10 linked by the admin relink', '1;member_linked>beto',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b6}'$$,
  '@{eva}',
  $$SELECT public.relink_fleet_member_for_existing_driver('{nico}', '+13055550199')$$,
  '@db',
  $$SELECT t.pushes()$$);
SELECT t.case('I11 removing an active driver tells them, and only them', 'removed_from_fleet>dora;Ya no estás en una flota;Beto R. te quitó de su flota.',
  $$UPDATE public.fleet_members SET status = 'active', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  '@{beto}',
  $$DELETE FROM public.fleet_members WHERE id = '{b3}'$$,
  '@db',
  $$SELECT t.pushes()$$,
  $$SELECT title FROM t.push$$,
  $$SELECT text FROM t.push$$);
SELECT t.case('I12 deleting a rejected row sends no push', 'none',
  $$UPDATE public.fleet_members SET status = 'rejected', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  $$DELETE FROM public.fleet_members WHERE id = '{b3}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I13 nor an inactive, approved or pending one', 'none',
  $$UPDATE public.fleet_members SET status = 'inactive', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  $$DELETE FROM public.fleet_members WHERE id IN ('{b3}', '{b1}', '{b4}')$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I14 a company deleted with its fleet tells the active drivers, with no name to give', 'removed_from_fleet>dora;Te quitaron de una flota.;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  $$DELETE FROM public.corporate_accounts WHERE id = '{caa}'$$,
  $$SELECT t.pushes()$$,
  $$SELECT text FROM t.push$$,
  $$SELECT count(*) FROM public.fleet_invite_sends WHERE fleet_id = '{dfa}'$$);
SELECT t.case('I15 an edit of another column says nothing', 'none',
  $$UPDATE public.fleet_members SET driver_email = 'a@b.c' WHERE id = '{b1}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I16 a reference moved by account deletion says nothing', 'none',
  $$UPDATE public.fleet_members SET status = 'active', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$DELETE FROM public.cron_http_calls$$,
  $$INSERT INTO auth.users (id) VALUES ('{gone}')$$,
  $$UPDATE public.fleet_members SET driver_id = '{gone}' WHERE id = '{b3}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I17 someone who turned approval notices off gets no push', 'none',
  $$INSERT INTO public.notification_preferences (user_id, driver_approval) VALUES ('{beto}', false)$$,
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{b1}'$$,
  $$SELECT t.pushes()$$);
SELECT t.case('I18 every push of this migration routes as fleet_update and sends no category', '6;true;false',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b2}', '{b3}')$$,
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{b1}'$$,
  $$UPDATE public.corporate_accounts SET status = 'suspended' WHERE id = '{caa}'$$,
  $$UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '{cap}'$$,
  $$SELECT count(*) FROM t.push$$,
  $$SELECT bool_and(type = 'fleet_update') FROM t.push$$,
  $$SELECT bool_or(raw ? 'category') FROM t.push$$);

-- ── J. What a driver sees of their fleets ────────────────────
SELECT t.case('J1 the columns the service layer reads', 'TABLE(member_id uuid, fleet_id uuid, fleet_name text, owner_label text, status text, driver_name text, driver_phone text, signed_up_at timestamp with time zone)',
  $$SELECT pg_get_function_result('public.get_my_fleet_memberships()'::regprocedure)$$);
SELECT t.case('J2 a driver in two fleets sees both, with the fleet name and who runs it', 'FLOTA-SECRETA|Ana M.|active,Flota Beto|Beto R.|active',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b3}', '{pa3}')$$,
  '@{dora}',
  $$SELECT string_agg(fleet_name || '|' || owner_label || '|' || status, ',' ORDER BY owner_label) FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J3 approved counts; pending_signup, review, rejected and inactive do not', 'approved',
  $$INSERT INTO public.corporate_accounts (id, name, contact_phone, status, created_by) VALUES ('{ca2}', 'Segunda', '+5355590002', 'approved', '{beto}')$$,
  $$INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('{df2}', '{ca2}', 'Segunda')$$,
  $$UPDATE public.fleet_members SET driver_id = '{dora}' WHERE id IN ('{pa1}', '{pa2}', '{pa3}', '{b1}')$$,
  $$UPDATE public.fleet_members SET status = 'rejected' WHERE id = '{pa1}'$$,
  $$UPDATE public.fleet_members SET status = 'inactive' WHERE id = '{pa2}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  $$INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('{df2}', '{dora}', 'Dora', '+5355599999', 'pending_signup')$$,
  '@{dora}',
  $$SELECT string_agg(status, ',' ORDER BY status) FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J4 one row per fleet: the active one wins over an approved twin', '1;active;Dora Vega',
  $$UPDATE public.fleet_members SET status = 'active', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status, added_at) VALUES ('{dfa}', '{dora}', 'Gemela', '+5355510006', 'approved', now() + interval '1 hour')$$,
  '@{dora}',
  $$SELECT count(*) FROM public.get_my_fleet_memberships()$$,
  $$SELECT status FROM public.get_my_fleet_memberships()$$,
  $$SELECT driver_name FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J5 active fleets come first', 'active,approved',
  $$UPDATE public.fleet_members SET status = 'active', driver_id = '{dora}' WHERE id = '{b3}'$$,
  $$UPDATE public.fleet_members SET status = 'approved', driver_id = '{dora}', signed_up_at = now() WHERE id = '{pa3}'$$,
  '@{dora}',
  $$SELECT string_agg(status, ',') FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J6 nobody else sees them', '0;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{nico}',
  $$SELECT count(*) FROM public.get_my_fleet_memberships()$$,
  '@service',
  $$SELECT count(*) FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J7 the driver cannot read the fleet table, and gets its name all the same', '0;Flota Beto',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT count(*) FROM public.driver_fleets$$,
  $$SELECT fleet_name FROM public.get_my_fleet_memberships()$$);
SELECT t.case('J8 an owner with no name shows the company', 'Beto Transporte',
  $$UPDATE public.users SET full_name = '' WHERE id = '{beto}'$$,
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b3}'$$,
  '@{dora}',
  $$SELECT owner_label FROM public.get_my_fleet_memberships()$$);

-- ── K. The ledger and the permissions ────────────────────────
SELECT t.case('K1 the owner reads their ledger', '1;+5355530001;sms;review',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@{beto}',
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  $$SELECT phone FROM public.fleet_invite_sends$$,
  $$SELECT channel FROM public.fleet_invite_sends$$,
  $$SELECT source FROM public.fleet_invite_sends$$);
SELECT t.case('K2 nobody else does: another owner, a stranger, the invited driver, an employee of the company', '0;0;0;0',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id IN ('{b1}', '{b3}')$$,
  $$INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, added_by) VALUES ('{caa}', '{nico}', 'employee', '{beto}')$$,
  '@{ana}',
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  '@{pepe}',
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  '@{dora}',
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  '@{nico}',
  $$SELECT count(*) FROM public.fleet_invite_sends$$);
SELECT t.case('K3 anon reads nothing', 'ERROR 42501',
  '@anon',
  $$SELECT count(*) FROM public.fleet_invite_sends$$);
SELECT t.case('K4 a client cannot insert', 'ERROR 42501',
  '@{beto}',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source) VALUES ('{dfa}', '+5355530001', '{b1}', 'sms', 'review')$$);
SELECT t.case('K5 nor update', 'ERROR 42501',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@{beto}',
  $$UPDATE public.fleet_invite_sends SET sent_at = now() - interval '2 days'$$);
SELECT t.case('K6 nor delete', 'ERROR 42501',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@{beto}',
  $$DELETE FROM public.fleet_invite_sends$$);
SELECT t.case('K7 the service role reads and writes it', '1;2',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@service',
  $$SELECT count(*) FROM public.fleet_invite_sends$$,
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source) VALUES ('{dfa}', '+5355530001', '{b1}', 'sms', 'resend')$$,
  $$SELECT count(*) FROM public.fleet_invite_sends$$);
SELECT t.case('K8 channel and source are closed lists', 'ERROR 23514',
  '@service',
  $$INSERT INTO public.fleet_invite_sends (fleet_id, phone, member_id, channel, source) VALUES ('{dfa}', '+5355530001', '{b1}', 'mail', 'review')$$);
SELECT t.case('K9 no function of this migration is open to anon', '8;0',
  $$SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_fleet_invite_sms_text', '_fleet_push', '_fleet_announce_member', 'resend_fleet_invite', 'leave_fleet', 'get_my_fleet_memberships', 'tg_fleet_members_notify', 'tg_corporate_accounts_fleet_notify')$$,
  $$SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('_fleet_invite_sms_text', '_fleet_push', '_fleet_announce_member', 'resend_fleet_invite', 'leave_fleet', 'get_my_fleet_memberships', 'tg_fleet_members_notify', 'tg_corporate_accounts_fleet_notify') AND has_function_privilege('anon', p.oid, 'EXECUTE')$$);
SELECT t.case('K10 anon cannot call resend_fleet_invite', 'ERROR 42501', '@anon', $$SELECT public.resend_fleet_invite('{b1}')$$);
SELECT t.case('K11 nor leave_fleet', 'ERROR 42501', '@anon', $$SELECT public.leave_fleet('{b1}')$$);
SELECT t.case('K12 nor get_my_fleet_memberships', 'ERROR 42501', '@anon', $$SELECT count(*) FROM public.get_my_fleet_memberships()$$);
SELECT t.case('K13 the helpers stay the owner''s: not a signed-in client', 'ERROR 42501', '@{beto}', $$SELECT public._fleet_announce_member('{b1}', 'review')$$);
SELECT t.case('K14 nor the service role', 'ERROR 42501', '@service', $$SELECT public._fleet_announce_member('{b1}', 'review')$$);
SELECT t.case('K15 a write by the service role still fires the notices', 'approved;1',
  '@service',
  $$UPDATE public.fleet_members SET status = 'approved' WHERE id = '{b1}'$$,
  '@db',
  $$SELECT status FROM public.fleet_members WHERE id = '{b1}'$$,
  $$SELECT count(*) FROM t.sms$$);
