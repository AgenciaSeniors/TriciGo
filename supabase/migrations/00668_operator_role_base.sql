-- ============================================================
-- 00668 — operator role, delivery 1 of 4: what the operator reads, the role lists, the alerts
-- Spec: docs/superpowers/specs/2026-10-25-operator-role-design.md
-- Plan: docs/superpowers/plans/2026-10-25-operator-role-base.md
-- Needs 00667 (the 'operator' value of user_role).
--
--   1. is_operator() and is_ops_staff().
--   2. SELECT policies for the operator on the tables its pages read, the vehicles admin policy
--      widened to operations staff, and storage reads of driver documents, contracts and receipts.
--   3. The seven panel views and _panel_driver_churn_risk() let the operator through, and
--      panel_rides counts an operator's cancel as staff's. ops_delivery_details: a delivery
--      without its code, for the operator.
--   4. Read RPC gates: metrics, incomplete signups, the corporate balance, the live fleet and
--      the context of the assist pages.
--   5. Role lists: ride transitions (an operator rides as a passenger), driver approval, rider
--      rating, the team functions and the team_invitations CHECK, the daily digest, the support
--      alert pushes.
--   6. A push to operators and admins on every SOS.
--   7. A copy saved with CRLF line endings leaves no carriage return in the new bodies.
--   8. Checks of everything above. A failed check aborts the whole file.
--
-- No operator action opens here: every write stays admin-only until deliveries 2 to 4.
-- Additive for every other role. Every function patch starts from the live body, runs only on
-- the body this file was written against (md5 below), is skipped on the body it leaves, and
-- refuses any other body. The views are patched the same way, from their deparsed text.
-- Rehearsal: supabase/tests/00668/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table. Every public table this file creates a policy on is locked
-- up front, and every app query on them waits behind this file until it commits.
-- There is no lock order that agrees with every app path: complete_ride_and_pay takes rides and
-- then driver_profiles, update_driver_position takes them the other way. So this file is meant to
-- be the one that gives up in a lock cycle: its lock_timeout (500 ms) is half of prod's
-- deadlock_timeout (1 s), the wait after which Postgres looks for a cycle and cancels one of the
-- transactions in it, possibly an app's. (An app transaction that had already waited more than
-- half a second when this file closed the cycle can still be the one cancelled.) The file then
-- rolls back whole. Apply it at a quiet hour; on 55P03 (lock_timeout) or 40P01 (deadlock) run it
-- again. The setting is reset at the end of the file; if the file aborts, the transaction takes
-- the setting with it.
SET lock_timeout = '500ms';

LOCK TABLE public.rides, public.ride_pricing_snapshots, public.ride_transitions, public.ride_messages
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.users, public.driver_profiles, public.vehicles, public.driver_documents,
  public.driver_score_events, public.driver_contracts, public.selfie_checks IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.wallet_accounts, public.ledger_transactions, public.ledger_entries,
  public.wallet_transfers, public.wallet_recharge_requests, public.wallet_receipts,
  public.cancellation_penalties IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.reviews, public.ticket_messages, public.support_tickets, public.ride_disputes,
  public.incident_reports, public.lost_items, public.fraud_alerts, public.cancellation_reviews
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.corporate_accounts, public.corporate_employees, public.corporate_rides,
  public.driver_fleets, public.fleet_members, public.promotions, public.referrals,
  public.stuck_ride_alerts, public.team_invitations IN ACCESS EXCLUSIVE MODE;
-- storage.objects is not locked here: its owner is Supabase's storage role, and postgres may
-- create a policy on it (supautils) but not necessarily lock it. CREATE POLICY takes its own lock
-- under the same lock_timeout.

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'user_role' AND t.typnamespace = 'public'::regnamespace
                   AND e.enumlabel = 'operator') THEN
    RAISE EXCEPTION '00668: needs 00667 (the operator value of user_role)';
  END IF;
END
$guard$;

-- 1. Helpers -------------------------------------------------------------------------------
-- Same shape as is_marketing() (00642): no JWT subject (anon, service role, cron) is never an
-- operator, and anon may not call current_user_role() (00517).
CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is an operator, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'operator';
END;
$fn$;

-- Admins, super admins and operators: the staff that runs operations.
CREATE OR REPLACE FUNCTION public.is_ops_staff()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  -- Admins, super admins and operators (00668). No JWT subject: false, with the early return of
  -- is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin', 'operator');
END;
$fn$;

-- Policies call them for every role that reads the table, anon included: without EXECUTE a
-- read by anon would fail with 42501 instead of returning false (00592, 00645).
REVOKE ALL ON FUNCTION public.is_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_ops_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_operator() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_ops_staff() TO anon, authenticated, service_role;

-- 2. Reads -----------------------------------------------------------------------------------
-- One SELECT policy per table, named <table>_select_operator. Each one only adds rows for the
-- operator: the other policies of the table do not change.
DO $policies$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'rides', 'ride_transitions', 'ride_pricing_snapshots', 'ride_messages', 'users',
    'driver_profiles', 'driver_documents', 'driver_score_events', 'driver_contracts', 'selfie_checks',
    'wallet_accounts', 'ledger_transactions', 'ledger_entries', 'wallet_transfers',
    'wallet_recharge_requests', 'wallet_receipts', 'cancellation_penalties', 'reviews',
    'ticket_messages', 'support_tickets', 'ride_disputes', 'incident_reports', 'lost_items',
    'fraud_alerts', 'cancellation_reviews', 'corporate_accounts', 'corporate_employees',
    'corporate_rides', 'driver_fleets', 'fleet_members', 'promotions', 'referrals',
    'stuck_ride_alerts']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = v_tbl
                     AND policyname = v_tbl || '_select_operator') THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.is_operator()))',
        v_tbl || '_select_operator', v_tbl);
    END IF;
  END LOOP;
END
$policies$;

-- vehicles: 00644 refuses a third SELECT policy on the table, so the admin one widens instead.
ALTER POLICY v_admin_select ON public.vehicles USING ((SELECT public.is_ops_staff()));

-- Storage: the operator opens driver documents and contracts (driver detail) and recharge
-- receipts (wallet) through signed URLs, which need SELECT on the object.
DO $storage$
DECLARE
  v_bucket text;
  v_name text;
BEGIN
  FOR v_bucket, v_name IN
    SELECT * FROM (VALUES
      ('driver-documents', 'storage_driver_documents_select_operator'),
      ('driver-contracts', 'storage_driver_contracts_select_operator'),
      ('receipts', 'storage_receipts_select_operator')
    ) AS v(b, n)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_name) THEN
      EXECUTE format('CREATE POLICY %I ON storage.objects FOR SELECT TO authenticated USING (bucket_id = %L AND (SELECT public.is_operator()))',
        v_name, v_bucket);
    END IF;
  END LOOP;
END
$storage$;

-- 3. Views -------------------------------------------------------------------------------------
-- The seven panel views end in the admin-or-marketing gate (00642, 00663). Each is recreated
-- from its own deparsed text with the operator added to that gate, and panel_rides also counts
-- an operator's cancel as staff's. Deparsed with search_path = pg_catalog, so every name in the
-- text is schema-qualified. CREATE OR REPLACE VIEW keeps the columns and the grants; the options
-- are given again because CREATE OR REPLACE resets them. Each view runs only on the definition
-- this file was written against (old md5, measured in prod on 2026-10-25), is skipped on the one
-- it leaves (new md5, measured in the rehearsal) and refuses any other.
DO $views$
DECLARE
  c_gate      constant text := 'WHERE (( SELECT public.is_admin() AS is_admin) OR ( SELECT public.is_marketing() AS is_marketing));';
  c_gate_new  constant text := 'WHERE (( SELECT public.is_admin() AS is_admin) OR ( SELECT public.is_marketing() AS is_marketing) OR ( SELECT public.is_operator() AS is_operator));';
  c_staff     constant text := $t$ARRAY['admin'::public.user_role, 'super_admin'::public.user_role]$t$;
  c_staff_new constant text := $t$ARRAY['admin'::public.user_role, 'super_admin'::public.user_role, 'operator'::public.user_role]$t$;
  v_path text := current_setting('search_path');
  v_rec record;
  v_def text;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);
  FOR v_rec IN
    SELECT * FROM (VALUES
      ('panel_driver_churn_risk', 'b87b6f0bc8d28b876f83689b321f9186', '4c330ab7bd5fdc183c2308dbd9ba2bd1'),
      ('panel_driver_documents',  '6d67c1d2cd218577e1d04c2778ffc163', '74055a9b910d5a537d595c4d65767c93'),
      ('panel_driver_profiles',   '0b033cc9fdbf0e9f2baa1c392e1e0dfc', '552b909c14c563224028f51856b8694f'),
      ('panel_incident_reports',  '4188a17c7cc3a7de1038bc9097f0c4e8', '42845330e233beeff8f616c57bc561ea'),
      ('panel_lost_items',        'ae8852916298e3a732f6f121c885568c', 'e6184e47553958386c33fdd05d676471'),
      ('panel_ride_disputes',     '8ea3d38235a707ca52f26f245f5340f4', '3553ba142b12c738e169d18f8a822dc4'),
      ('panel_rides',             '5669aa5ad6fc84317a5ae8eb9f48a40c', '8c6989cdaa84779f548e7efe0ebe2ce4')
    ) AS v(name, old_md5, new_md5)
  LOOP
    v_def := pg_get_viewdef(('public.' || v_rec.name)::regclass);
    CONTINUE WHEN md5(v_def) = v_rec.new_md5;
    IF md5(v_def) <> v_rec.old_md5 THEN
      RAISE EXCEPTION '00668: view % has a definition this file does not know (md5 %)', v_rec.name, md5(v_def);
    END IF;
    -- The slice below cuts exactly the old gate off the end: make sure it is there.
    IF right(v_def, length(c_gate)) <> c_gate THEN
      RAISE EXCEPTION '00668: view % does not end in the admin-or-marketing gate', v_rec.name;
    END IF;
    v_def := left(v_def, length(v_def) - length(c_gate)) || c_gate_new;
    IF v_rec.name = 'panel_rides' THEN
      IF (length(v_def) - length(replace(v_def, c_staff, ''))) / length(c_staff) <> 1 THEN
        RAISE EXCEPTION '00668: the staff list is not in panel_rides exactly once';
      END IF;
      v_def := replace(v_def, c_staff, c_staff_new);
    END IF;
    EXECUTE format('CREATE OR REPLACE VIEW public.%I WITH (security_barrier = true, security_invoker = false) AS %s',
      v_rec.name, rtrim(v_def, ';'));
    IF md5(pg_get_viewdef(('public.' || v_rec.name)::regclass)) <> v_rec.new_md5 THEN
      RAISE EXCEPTION '00668: view % was recreated with an unexpected definition (md5 %)', v_rec.name,
        md5(pg_get_viewdef(('public.' || v_rec.name)::regclass));
    END IF;
  END LOOP;
  PERFORM set_config('search_path', v_path, true);
END
$views$;

-- A delivery as the operator sees it: every column of delivery_details but the delivery code,
-- which only the recipient and admins hold. Not security_invoker (delivery_details' RLS shows
-- the operator nothing), with security_barrier and the operator gate in WHERE. Admins keep
-- reading delivery_details itself.
CREATE OR REPLACE VIEW public.ops_delivery_details
WITH (security_barrier = true, security_invoker = false) AS
SELECT d.id, d.ride_id, d.pickup_description, d.dropoff_description, d.package_type,
       d.estimated_weight, d.recipient_phone, d.recipient_name, d.delivery_photo_url, d.notes,
       d.created_at, d.package_description, d.estimated_weight_kg, d.special_instructions,
       d.package_category, d.package_length_cm, d.package_width_cm, d.package_height_cm,
       d.client_accompanies, d.delivery_vehicle_type, d.pickup_photo_url, d.delivery_otp_validated_at
FROM public.delivery_details d
WHERE (SELECT public.is_operator());
-- Until 2026-10-30 every new object in public is born with every privilege for the API roles:
-- revoke all of them, then grant the read.
REVOKE ALL ON public.ops_delivery_details FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ops_delivery_details TO authenticated;
GRANT SELECT ON public.ops_delivery_details TO service_role;

-- 4 and 5. Patches of live functions ----------------------------------------------------------
-- Each row: the function, its body before and after (md5 of prosrc, measured in prod on
-- 2026-10-25), and the replacements, each with the number of times its target must appear.
-- Targets and replacements lose any \r, so a copy saved with CRLF patches to the same bodies.
DO $patch$
DECLARE
  c_mkt     constant text := 'IF NOT (public.is_admin() OR public.is_marketing()) THEN';
  c_mkt_op  constant text := 'IF NOT (public.is_admin() OR public.is_marketing() OR public.is_operator()) THEN';
  c_adm     constant text := 'IF NOT public.is_admin() THEN';
  c_ops     constant text := 'IF NOT public.is_ops_staff() THEN';
  c_team    constant text := $t$('super_admin', 'admin', 'marketing')$t$;
  c_team_op constant text := $t$('super_admin', 'admin', 'marketing', 'operator')$t$;
  c_msg     constant text := 'El rol tiene que ser superadministrador, administrador o marketing.';
  c_msg_op  constant text := 'El rol tiene que ser superadministrador, administrador, marketing u operador.';
  v_rec record;
  v_p jsonb;
  v_src text;
  v_def text;
  v_md5 text;
  v_target text;
  v_repl text;
BEGIN
  FOR v_rec IN
    SELECT * FROM (VALUES
      -- 4. Reads the operator's pages call.
      ('public.get_admin_dashboard_metrics()', '32cec76d3f079f6938b09f8bb7e919b2', '8b5f98c002141541b6837511ccee100c',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_admin_wallet_stats()', '0f937c94cda1d26e7dd2da7d574949dd', '21cd9a7f16058d01740029b430cf13d9',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_rides_by_day(integer)', 'fd5363b072a17da61325a23cfd1486af', '339b0f0dbf075ea8c470097be5495bb1',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_rides_by_service_type(integer)', 'ffd6c633752a21bba4945625fc9aaaaf', '1cd2058668e150fb7ce5d228cb9ab389',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_rides_by_payment_method(integer)', '2ecacefdfef6c96da84d3b2f20a0b138', 'beb36eb41b576ec41e81430e9f6e8308',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_top_drivers(integer)', '03e7be0213769612782ed3bcb0183f3a', 'b3b7bfa483c01f678c53b05fb35d2942',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_peak_hours(integer)', '29e882b3dfbf6c3f2d5ad5946d04e3d8', '9cc7e8ba4a44a026e5c7a02c939ad466',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_driver_utilization()', 'deb8280b477f4dc4ccf64acfcdd0cafa', '1f4c8030ad426c728d47008afe6567fb',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.get_product_failures(integer)', '57a40ccc37b3efd3f6053804d922b03e', 'f735ec7c60ad2405226983505677fe0a',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.admin_launch_pulse(integer)', 'bb5d37a5bca57a64d3e3409ada2dd6b6', '8a1937bbe51baf3772cfd067f7d3df2e',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.admin_incomplete_driver_signups()', '65aad048b3031c8398c21cf3649bd47f', '8b9c5c6014c48768b51735b199d34d81',
       jsonb_build_array(jsonb_build_array(c_mkt, c_mkt_op, 1))),
      ('public.admin_support_waiting_rides()', 'cf28c7189a299171fbc876981cab0fde', '6220ecbb3b398b62c22dc2534ce55570',
       jsonb_build_array(jsonb_build_array(c_adm, c_ops, 1))),
      ('public.admin_ride_assist_context(uuid)', 'b4f972c16a8105000b473584b2d9972e', '2b7a2a9cb6ca0566c3fde8614220e91a',
       jsonb_build_array(jsonb_build_array(c_adm, c_ops, 1))),
      ('public.admin_ride_assist_candidates(uuid,text)', '8fc752f5230186f458d8b81ce1f82bad', '18ec24b4eff82a82c401df6889eb399c',
       jsonb_build_array(jsonb_build_array(c_adm, c_ops, 1))),
      ('public.admin_active_ride_context(uuid)', '648f573019cac9a07b8f6c0bc9b53cf1', '76344d251a2f75b1d4c9f4f059131668',
       jsonb_build_array(jsonb_build_array(c_adm, c_ops, 1))),
      ('public.admin_get_online_fleet()', '16cae4581898b17f1f0da664e1424c9e', '09160feb71a0436f0ceb5648ccba2081',
       jsonb_build_array(jsonb_build_array($t$  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin
  FROM users WHERE id = auth.uid();$t$, '  v_is_admin := public.is_ops_staff();', 1))),
      ('public.get_corporate_balance(uuid)', '3f0a78535f6f62def35d7544abead12c', 'b607f588cce860b868a53755ecbbcd7a',
       jsonb_build_array(jsonb_build_array(
         'IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN',
         'IF NOT (public.is_admin() OR public.is_operator() OR public.is_corp_admin(p_account_id)) THEN', 1))),
      ('public.get_corporate_employees(uuid)', '707be40934363bf3444de3c66d573e4c', '64e9679cb6d0b677dda93a6490bd465b',
       jsonb_build_array(jsonb_build_array(
         'IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN',
         'IF NOT (public.is_admin() OR public.is_operator() OR public.is_corp_admin(p_account_id)) THEN', 1))),
      ('public._panel_driver_churn_risk()', '20240a8b10635d4349bc31b96ef0eb50', 'afa2e6a392bdf498d226d1e8db94ebf9',
       jsonb_build_array(jsonb_build_array(
         'WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());',
         'WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing()) OR (SELECT public.is_operator());', 1))),
      -- 5. Role lists.
      ('public.enforce_ride_transition()', 'f806997fab31c18e7b369e69f5321c30', '0f18b49d2d65e00923fa7f8d136b2387',
       jsonb_build_array(jsonb_build_array($t$  IF v_user_role = 'marketing' THEN$t$,
                                           $t$  IF v_user_role IN ('marketing', 'operator') THEN$t$, 1))),
      ('public.ensure_driver_role_and_tricicoin_on_approval()', '1940d4379a446c8afdf0d47434945c07', 'ee418d59c865532fcdb6df0af3b991b2',
       jsonb_build_array(jsonb_build_array($t$AND role NOT IN ('driver', 'admin', 'super_admin', 'marketing');$t$,
                                           $t$AND role NOT IN ('driver', 'admin', 'super_admin', 'marketing', 'operator');$t$, 1))),
      ('public.apply_user_rating(uuid)', '96be8c154990651738312ef44861242f', '855ff6a7587434d60c8e45c2112cf7a3',
       jsonb_build_array(jsonb_build_array($t$ELSIF v_role IN ('customer', 'super_admin', 'admin', 'marketing') THEN$t$,
                                           $t$ELSIF v_role IN ('customer', 'super_admin', 'admin', 'marketing', 'operator') THEN$t$, 1))),
      ('public._support_alert(uuid,text)', '1ee5af719375723f47a7e17e037c0781', '992c2ce11b664d72e437a683170abb97',
       jsonb_build_array(jsonb_build_array($t$WHERE u.role IN ('admin', 'super_admin') AND u.is_active;$t$,
                                           $t$WHERE u.role IN ('admin', 'super_admin', 'operator') AND u.is_active;$t$, 1))),
      ('public.team_digest_recipients()', '07045d8aa3abed148082614ba441e01e', 'a64e560f1aef14b8b1a782865d5624c9',
       jsonb_build_array(jsonb_build_array($t$WHERE u.role IN ('super_admin', 'admin', 'marketing')$t$,
                                           $t$WHERE u.role IN ('super_admin', 'admin', 'marketing', 'operator')$t$, 1))),
      ('public._team_role_rank(text)', 'b4d7921637a5ce8ac112b1ccf2b4c47e', '149307088a8dbbcb9eebb662187e260b',
       jsonb_build_array(jsonb_build_array($t$WHEN 'marketing' THEN 1 ELSE 0 END$t$,
                                           $t$WHEN 'marketing' THEN 1 WHEN 'operator' THEN 1 ELSE 0 END$t$, 1))),
      ('public._team_lock_target(uuid,uuid)', 'bf7977def160b0af45d331f6c8ba6aa8', 'de70508776541e934d4225ce6e3c3510',
       jsonb_build_array(jsonb_build_array(c_team, c_team_op, 1))),
      ('public.list_team()', '3caa19878a9f42757340073dd44a8e63', '54b81a4f2941beff89205a37c95f8fc9',
       jsonb_build_array(jsonb_build_array(c_team, c_team_op, 2))),
      ('public.create_team_invitation(text,text,text)', '208a91a24bdde5104dc298616aa41668', 'fba442720206be555335875c37968405',
       jsonb_build_array(jsonb_build_array(c_team, c_team_op, 2), jsonb_build_array(c_msg, c_msg_op, 1))),
      ('public.set_team_member_role(uuid,text,text)', '0efaca07aab64cbebde239d4db8515b6', 'e835ab6ff0f4b4f7310aca565ba08e80',
       jsonb_build_array(jsonb_build_array(c_team, c_team_op, 1), jsonb_build_array(c_msg, c_msg_op, 1)))
    ) AS v(fn, old_md5, new_md5, patches)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_rec.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = v_rec.new_md5;
    IF v_md5 <> v_rec.old_md5 THEN
      RAISE EXCEPTION '00668: % has a body this file does not know (md5 %); patch it from the live body', v_rec.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(v_rec.fn::regprocedure);
    FOR v_p IN SELECT value FROM jsonb_array_elements(v_rec.patches) LOOP
      v_target := replace(v_p->>0, chr(13), '');
      v_repl := replace(v_p->>1, chr(13), '');
      IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> (v_p->>2)::int
         OR (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target) <> (v_p->>2)::int THEN
        RAISE EXCEPTION '00668: a target is not in % exactly % time(s): %', v_rec.fn, v_p->>2, v_target;
      END IF;
      v_src := replace(v_src, v_target, v_repl);
      v_def := replace(v_def, v_target, v_repl);
    END LOOP;
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_rec.fn::regprocedure;
    IF v_md5 <> v_rec.new_md5 THEN
      RAISE EXCEPTION '00668: % patched to an unexpected body (md5 %)', v_rec.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- An invitation may be for an operator. The constraint is replaced, not loosened for anything
-- else: the same three roles plus operator.
ALTER TABLE public.team_invitations DROP CONSTRAINT IF EXISTS team_invitations_role_check;
ALTER TABLE public.team_invitations ADD CONSTRAINT team_invitations_role_check
  CHECK (role IN ('super_admin', 'admin', 'marketing', 'operator'));

-- 6. SOS: a push to operations staff ----------------------------------------------------------
-- An SOS showed only in an open panel (banner and bell) and texted the rider's trusted contacts
-- (notify_trusted_contacts_on_sos). This adds a push to every active operator and admin, with a
-- link to the incident, through cron_http_post (label sos-staff-alert): check_cron_http_failures
-- reports it when send-push refuses it. One push per reporter and minute. It runs in its own
-- exception block: an SOS is never refused because its alert failed.
--   * The title carries the reporter's first name and initial (_third_party_person_name, as in
--     the trusted-contact texts), and "[Prueba] " for a test account: store reviewers use the
--     demo accounts, and staff must see their SOS but know it is a test.
--   * lock_timeout: the rate limit upserts a rate_limits row, and a second SOS of the same person
--     waits on the first one's lock. Without a limit that wait would end in statement_timeout,
--     which WHEN OTHERS cannot catch, and the SOS insert itself would be cancelled. A lock
--     timeout is an ordinary error: the handler logs it and the SOS is kept.
--   * search_path is empty: every name below is schema-qualified.
CREATE OR REPLACE FUNCTION public._sos_staff_alert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
AS $fn$
DECLARE
  v_staff   uuid[];
  v_key     text;
  v_name    text;
  v_is_test boolean;
  v_allowed boolean;
BEGIN
  IF NEW.type <> 'sos' THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT r.allowed INTO v_allowed FROM public.check_rate_limit('sos-staff:' || NEW.reported_by::text, 1, 60) r;
    IF NOT coalesce(v_allowed, true) THEN
      RETURN NEW;
    END IF;
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING '_sos_staff_alert: no service role key, the push for incident % was not sent', NEW.id;
      PERFORM public.log_rpc_attempt('_sos_staff_alert', NEW.reported_by, NEW.id, 'alert_failed',
        jsonb_build_object('error', 'no service role key'));
      RETURN NEW;
    END IF;
    SELECT array_agg(u.id) INTO v_staff
    FROM public.users u
    WHERE u.role IN ('admin', 'super_admin', 'operator') AND u.is_active
      AND u.id IS DISTINCT FROM NEW.reported_by;
    IF v_staff IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT public._third_party_person_name(u.full_name), coalesce(u.is_test, false)
      INTO v_name, v_is_test
    FROM public.users u WHERE u.id = NEW.reported_by;
    PERFORM public.cron_http_post('sos-staff-alert',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      body    := jsonb_build_object(
        'user_ids', to_jsonb(v_staff),
        'title', CASE WHEN v_is_test THEN '[Prueba] ' ELSE '' END
                 || 'SOS · ' || coalesce(nullif(v_name, ''), 'Usuario sin nombre'),
        'body', 'Alguien pidió ayuda de emergencia. Abre el panel para atenderla.',
        'category', 'system',
        'data', jsonb_build_object('event', 'sos_staff', 'incident_id', NEW.id::text,
                                   'url', 'https://admin.tricigo.com/incidents/' || NEW.id::text)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '_sos_staff_alert failed for incident %: % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('_sos_staff_alert', NEW.reported_by, NEW.id, 'alert_failed',
      jsonb_build_object('error', SQLERRM));
  END;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public._sos_staff_alert() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER incident_reports_sos_staff_alert
  AFTER INSERT ON public.incident_reports
  FOR EACH ROW WHEN (NEW.type = 'sos')
  EXECUTE FUNCTION public._sos_staff_alert();

-- 7. A copy pasted with CRLF line endings leaves carriage returns in the bodies --------------
-- Recreate each function this file creates from the catalogue without them, so its md5 is the
-- one section 8 expects. CREATE OR REPLACE keeps the grants. The patched bodies need nothing:
-- section 4 strips \r.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.is_operator()', 'public.is_ops_staff()',
                               'public._sos_staff_alert()']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 8. Checks ----------------------------------------------------------------------------------
DO $check$
DECLARE
  c_o        constant text := '( SELECT public.is_operator() AS is_operator)';
  c_gate_new constant text := 'WHERE (( SELECT public.is_admin() AS is_admin) OR ( SELECT public.is_marketing() AS is_marketing) OR ( SELECT public.is_operator() AS is_operator));';
  c_tables   constant text[] := ARRAY[
    'rides', 'ride_transitions', 'ride_pricing_snapshots', 'ride_messages', 'users',
    'driver_profiles', 'driver_documents', 'driver_score_events', 'driver_contracts', 'selfie_checks',
    'wallet_accounts', 'ledger_transactions', 'ledger_entries', 'wallet_transfers',
    'wallet_recharge_requests', 'wallet_receipts', 'cancellation_penalties', 'reviews',
    'ticket_messages', 'support_tickets', 'ride_disputes', 'incident_reports', 'lost_items',
    'fraud_alerts', 'cancellation_reviews', 'corporate_accounts', 'corporate_employees',
    'corporate_rides', 'driver_fleets', 'fleet_members', 'promotions', 'referrals',
    'stuck_ride_alerts'];
  v_path text := current_setting('search_path');
  v_tbl text;
  v_name text;
  v_def text;
  v_got text;
  v_want text;
  v_n bigint;
  v_rec record;
BEGIN
  PERFORM set_config('search_path', 'pg_catalog', true);

  -- Helpers: their bodies, invoker, callable by anon, authenticated and the service role.
  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('public.is_operator()', '16438eb527af61eaa2d0b3d9a53f08f9'),
      ('public.is_ops_staff()', 'd6774e4677be1072e66b247492e9cb9a'),
      ('public._sos_staff_alert()', '6da23321f4fe680cb89f8585ce8e56e8')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) IS DISTINCT FROM v_def THEN
      RAISE EXCEPTION '00668: % does not have the body of this file (md5 %)', v_name,
        (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure);
    END IF;
  END LOOP;
  IF (SELECT bool_or(prosecdef) FROM pg_proc
      WHERE oid IN ('public.is_operator()'::regprocedure, 'public.is_ops_staff()'::regprocedure)) THEN
    RAISE EXCEPTION '00668: is_operator() and is_ops_staff() must be SECURITY INVOKER';
  END IF;
  IF NOT (has_function_privilege('anon', 'public.is_operator()', 'EXECUTE')
          AND has_function_privilege('anon', 'public.is_ops_staff()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.is_operator()', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.is_ops_staff()', 'EXECUTE')) THEN
    RAISE EXCEPTION '00668: anon and authenticated must be able to call is_operator() and is_ops_staff()';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public._sos_staff_alert()'::regprocedure)
     OR has_function_privilege('anon', 'public._sos_staff_alert()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sos_staff_alert()', 'EXECUTE') THEN
    RAISE EXCEPTION '00668: _sos_staff_alert() must be SECURITY DEFINER and not executable by clients';
  END IF;
  -- Its settings: an empty search_path, and the lock timeout that keeps a lock wait from
  -- cancelling the SOS.
  SELECT array_to_string(proconfig, ',') INTO v_got FROM pg_proc WHERE oid = 'public._sos_staff_alert()'::regprocedure;
  IF v_got IS DISTINCT FROM 'search_path="",lock_timeout=2s' THEN
    RAISE EXCEPTION '00668: _sos_staff_alert() has the settings % instead of search_path="",lock_timeout=2s', coalesce(v_got, 'none');
  END IF;
  -- is_admin() itself does not change (00592).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.is_admin()'::regprocedure) <> '22cb75e91980d512498034cd33e1eda2' THEN
    RAISE EXCEPTION '00668: is_admin() is not the body of 00592';
  END IF;

  -- Without a JWT subject, and as anon, nobody is an operator or operations staff.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF public.is_operator() IS DISTINCT FROM false OR public.is_ops_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION '00668: is_operator() or is_ops_staff() is not false without a JWT subject';
  END IF;
  EXECUTE 'SET LOCAL ROLE anon';
  IF public.is_operator() IS DISTINCT FROM false OR public.is_ops_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION '00668: is_operator() or is_ops_staff() is not false for anon';
  END IF;
  EXECUTE 'RESET ROLE';

  -- The table policies, exactly as this file creates them.
  FOREACH v_tbl IN ARRAY c_tables LOOP
    SELECT p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '-') || '|' || coalesce(p.with_check, '-')
      INTO v_got
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.policyname = v_tbl || '_select_operator';
    v_want := 'SELECT|PERMISSIVE|{authenticated}|' || c_o || '|-';
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '00668: policy %_select_operator is % instead of %', v_tbl, coalesce(v_got, 'missing'), v_want;
    END IF;
  END LOOP;

  -- The storage policies.
  FOR v_name, v_want IN
    SELECT * FROM (VALUES
      ('storage_driver_documents_select_operator', 'SELECT|PERMISSIVE|{authenticated}|((bucket_id = ''driver-documents''::text) AND ' || c_o || ')|-'),
      ('storage_driver_contracts_select_operator', 'SELECT|PERMISSIVE|{authenticated}|((bucket_id = ''driver-contracts''::text) AND ' || c_o || ')|-'),
      ('storage_receipts_select_operator',         'SELECT|PERMISSIVE|{authenticated}|((bucket_id = ''receipts''::text) AND ' || c_o || ')|-')
    ) AS v(n, w)
  LOOP
    SELECT p.cmd || '|' || p.permissive || '|' || p.roles::text || '|' || coalesce(p.qual, '-') || '|' || coalesce(p.with_check, '-')
      INTO v_got
    FROM pg_policies p WHERE p.schemaname = 'storage' AND p.tablename = 'objects' AND p.policyname = v_name;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '00668: storage policy % is % instead of %', v_name, coalesce(v_got, 'missing'), v_want;
    END IF;
  END LOOP;

  -- vehicles: v_admin_select now admits operations staff, and still nothing else.
  SELECT p.cmd || '|' || coalesce(p.qual, '-') INTO v_got FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.tablename = 'vehicles' AND p.policyname = 'v_admin_select';
  IF v_got IS DISTINCT FROM 'SELECT|( SELECT public.is_ops_staff() AS is_ops_staff)' THEN
    RAISE EXCEPTION '00668: v_admin_select is %', coalesce(v_got, 'missing');
  END IF;

  -- Exactly these policies mention the operator: the 33 above, the 3 storage ones and vehicles.
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ' ORDER BY 1) INTO v_got
  FROM pg_policies
  WHERE (position('is_operator' IN coalesce(qual, '') || coalesce(with_check, '')) > 0
         OR position('is_ops_staff' IN coalesce(qual, '') || coalesce(with_check, '')) > 0)
    AND NOT (schemaname = 'public' AND policyname = tablename || '_select_operator' AND tablename = ANY (c_tables))
    AND NOT (schemaname = 'storage' AND tablename = 'objects' AND policyname IN (
      'storage_driver_documents_select_operator', 'storage_driver_contracts_select_operator',
      'storage_receipts_select_operator'))
    AND NOT (schemaname = 'public' AND tablename = 'vehicles' AND policyname = 'v_admin_select');
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '00668: unexpected policies mention the operator: %', v_got;
  END IF;
  -- And no policy named for the operator does anything but SELECT.
  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_got
  FROM pg_policies WHERE policyname LIKE '%\_operator' AND cmd <> 'SELECT';
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '00668: operator policies that are not SELECT: %', v_got;
  END IF;

  -- The views: every panel_% view ends in the new gate, panel_rides counts the operator as staff,
  -- and each keeps its options.
  FOR v_rec IN SELECT c.oid, c.relname, c.reloptions FROM pg_class c
               WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname LIKE 'panel\_%' LOOP
    v_def := pg_get_viewdef(v_rec.oid);
    IF right(v_def, length(c_gate_new)) <> c_gate_new THEN
      RAISE EXCEPTION '00668: view % does not end in the admin, marketing or operator gate', v_rec.relname;
    END IF;
    IF v_rec.reloptions IS DISTINCT FROM ARRAY['security_barrier=true', 'security_invoker=false'] THEN
      RAISE EXCEPTION '00668: view % has options %', v_rec.relname, v_rec.reloptions;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'v' AND relname LIKE 'panel\_%') <> 7 THEN
    RAISE EXCEPTION '00668: expected the seven panel views';
  END IF;
  -- And each one is exactly the definition section 3 leaves (md5 of pg_get_viewdef with
  -- search_path = pg_catalog, measured in the rehearsal).
  FOR v_name, v_want IN
    SELECT * FROM (VALUES
      ('panel_driver_churn_risk', '4c330ab7bd5fdc183c2308dbd9ba2bd1'),
      ('panel_driver_documents',  '74055a9b910d5a537d595c4d65767c93'),
      ('panel_driver_profiles',   '552b909c14c563224028f51856b8694f'),
      ('panel_incident_reports',  '42845330e233beeff8f616c57bc561ea'),
      ('panel_lost_items',        'e6184e47553958386c33fdd05d676471'),
      ('panel_ride_disputes',     '3553ba142b12c738e169d18f8a822dc4'),
      ('panel_rides',             '8c6989cdaa84779f548e7efe0ebe2ce4')
    ) AS v(n, m)
  LOOP
    v_got := md5(pg_get_viewdef(('public.' || v_name)::regclass));
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '00668: view % is not the definition of this file (md5 %)', v_name, v_got;
    END IF;
  END LOOP;
  IF position($t$ARRAY['admin'::public.user_role, 'super_admin'::public.user_role, 'operator'::public.user_role]$t$
              IN pg_get_viewdef('public.panel_rides'::regclass)) = 0 THEN
    RAISE EXCEPTION '00668: panel_rides does not count an operator cancel as staff';
  END IF;

  -- ops_delivery_details: no delivery code, the operator gate, read-only for authenticated and
  -- the service role, nothing for anon.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'ops_delivery_details' AND column_name = 'delivery_otp') THEN
    RAISE EXCEPTION '00668: ops_delivery_details carries the delivery code';
  END IF;
  IF right(pg_get_viewdef('public.ops_delivery_details'::regclass), length('WHERE ' || c_o || ';')) <> 'WHERE ' || c_o || ';'
     OR (SELECT reloptions FROM pg_class WHERE oid = 'public.ops_delivery_details'::regclass)
        IS DISTINCT FROM ARRAY['security_barrier=true', 'security_invoker=false'] THEN
    RAISE EXCEPTION '00668: ops_delivery_details is not the view of this file';
  END IF;
  SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) INTO v_got
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND table_name = 'ops_delivery_details' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC');
  IF v_got IS DISTINCT FROM 'authenticated:SELECT,service_role:SELECT' THEN
    RAISE EXCEPTION '00668: ops_delivery_details grants are %', v_got;
  END IF;

  -- Exactly these functions mention is_operator( or is_ops_staff(, each with the body this file
  -- leaves.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_got
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'is_(operator|ops_staff)\('
    AND p.oid::regprocedure::text NOT IN (
      'public.get_admin_dashboard_metrics()', 'public.get_admin_wallet_stats()',
      'public.get_rides_by_day(integer)', 'public.get_rides_by_service_type(integer)',
      'public.get_rides_by_payment_method(integer)', 'public.get_top_drivers(integer)',
      'public.get_peak_hours(integer)', 'public.get_driver_utilization()',
      'public.get_product_failures(integer)', 'public.admin_launch_pulse(integer)',
      'public.admin_incomplete_driver_signups()', 'public.admin_support_waiting_rides()',
      'public.admin_ride_assist_context(uuid)', 'public.admin_ride_assist_candidates(uuid,text)',
      'public.admin_active_ride_context(uuid)', 'public.admin_get_online_fleet()',
      'public.get_corporate_balance(uuid)', 'public.get_corporate_employees(uuid)',
      'public._panel_driver_churn_risk()');
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '00668: unexpected functions mention the operator: %', v_got;
  END IF;

  -- The money, role and team functions never open to the operator. Checked by name, every
  -- overload; a name that does not exist has nothing to open (the rehearsal's scaffold lacks
  -- admin_refund_ride_commission and admin_send_wallet_v2_bonus_push, which prod has: its
  -- negative proofs create them to show this check catches them).
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_got
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('admin_adjust_wallet', 'admin_send_gift', 'admin_reverse_gift', 'freeze_wallet',
                      'unfreeze_wallet', 'approve_wallet_recharge', 'process_dispute_refund',
                      'admin_reward_referral', 'admin_invalidate_referral', 'set_referral_amounts',
                      'get_platform_earnings', 'promote_user_role', 'admin_set_user_level',
                      'admin_set_user_active', 'admin_refund_ride_commission',
                      'admin_send_wallet_v2_bonus_push')
    AND (p.prosrc ~ 'is_(operator|ops_staff)\(' OR p.prosrc ~ '''operator''');
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '00668: % must stay closed to the operator', v_got;
  END IF;

  -- Exactly these functions carry the quoted literal 'operator' in their body: the role lists
  -- section 5 patches and the three functions this file creates. Extension functions are not
  -- this file's and are left out. (A bare search for the word would also find code that names
  -- an OSM operator tag or a PostGIS operator.)
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text COLLATE "C") INTO v_got
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND position('''operator''' IN p.prosrc) > 0
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  v_want := 'public._sos_staff_alert(), public._support_alert(uuid,text), public._team_lock_target(uuid,uuid), '
         || 'public._team_role_rank(text), public.apply_user_rating(uuid), '
         || 'public.create_team_invitation(text,text,text), public.enforce_ride_transition(), '
         || 'public.ensure_driver_role_and_tricicoin_on_approval(), public.is_operator(), '
         || 'public.is_ops_staff(), public.list_team(), public.set_team_member_role(uuid,text,text), '
         || 'public.team_digest_recipients()';
  IF v_got IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION '00668: the functions with the quoted operator literal are % instead of %', coalesce(v_got, 'none'), v_want;
  END IF;

  -- The team CHECK: exactly one CHECK constraint of team_invitations reads its role column, and it
  -- is the one of this file.
  SELECT count(*), string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), '; ') INTO v_n, v_got
  FROM pg_constraint c
  WHERE c.conrelid = 'public.team_invitations'::regclass AND c.contype = 'c'
    AND (SELECT a.attnum FROM pg_attribute a
         WHERE a.attrelid = 'public.team_invitations'::regclass AND a.attname = 'role') = ANY (c.conkey);
  IF v_n <> 1 OR v_got IS DISTINCT FROM
     $t$team_invitations_role_check CHECK ((role = ANY (ARRAY['super_admin'::public.user_role, 'admin'::public.user_role, 'marketing'::public.user_role, 'operator'::public.user_role])))$t$ THEN
    RAISE EXCEPTION '00668: the role CHECK of team_invitations is not the one of this file: %', coalesce(v_got, 'none');
  END IF;

  -- The SOS trigger: exactly this definition, and enabled.
  SELECT pg_get_triggerdef(t.oid) INTO v_got FROM pg_trigger t
  WHERE t.tgrelid = 'public.incident_reports'::regclass AND t.tgname = 'incident_reports_sos_staff_alert'
    AND t.tgenabled = 'O';
  IF v_got IS DISTINCT FROM
     $t$CREATE TRIGGER incident_reports_sos_staff_alert AFTER INSERT ON public.incident_reports FOR EACH ROW WHEN ((new.type = 'sos'::public.incident_type)) EXECUTE FUNCTION public._sos_staff_alert()$t$ THEN
    RAISE EXCEPTION '00668: incident_reports_sos_staff_alert must be AFTER INSERT FOR EACH ROW WHEN (NEW.type = sos), enabled; it is %', coalesce(v_got, 'missing or disabled');
  END IF;

  -- _sos_staff_alert() runs as its owner: the owner must be able to call each function it calls
  -- (by name, so this does not depend on their argument lists).
  SELECT string_agg(n.fn, ', ' ORDER BY n.fn) INTO v_got
  FROM unnest(ARRAY['check_rate_limit', 'get_service_role_key', 'log_rpc_attempt',
                    '_third_party_person_name', 'cron_http_post']) AS n(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n.fn
      AND has_function_privilege((SELECT proowner FROM pg_proc WHERE oid = 'public._sos_staff_alert()'::regprocedure),
                                 p.oid, 'EXECUTE'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION '00668: the owner of _sos_staff_alert() cannot execute %', v_got;
  END IF;

  PERFORM set_config('search_path', v_path, true);
END
$check$;

RESET lock_timeout;
