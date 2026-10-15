-- ============================================================
-- 00663 — marketing reads more of the admin panel, and answers support
-- Spec: docs/superpowers/specs/2026-10-15-marketing-visibility-design.md
-- Needs 00642 (is_marketing() and the panel views).
--
--   1. Panel views. panel_rides and panel_driver_profiles gain columns; four new views (driver
--      documents, churn risk, disputes, incidents) leave out files, money and internal notes.
--      Churn risk reads driver_churn_risk through _panel_driver_churn_risk(), a definer function:
--      that view is security_invoker and would show marketing nothing through a plain view.
--   2. SELECT policies for marketing on tables with nothing to hide.
--   3. The read RPCs of the opened pages let marketing through their admin gate.
--   4. Support: marketing replies as support and changes a ticket's status, and nothing else.
--   5. get_product_failures(): the "Fallas del producto" section of Reportes.
--   6. Checks of everything above. A failed check aborts the whole file.
--
-- Additive: nothing that exists is loosened for any other role, and nothing is dropped.
-- Every function patch starts from the live body, runs only on the body this file was written
-- against (md5 below), is skipped on the body it leaves, and refuses any other body.
-- Rehearsal: supabase/tests/00663/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table; fail fast instead of queueing the app's reads behind us.
SET lock_timeout = '5s';

-- Every table this file touches, locked up front: a ride first, then its people. ACCESS EXCLUSIVE
-- where a policy or trigger is created, ACCESS SHARE where a view only reads it. On 40P01
-- (deadlock) or 55P03 (lock_timeout) the whole file rolls back; run it again.
LOCK TABLE public.rides IN ACCESS SHARE MODE;
LOCK TABLE public.ride_transitions, public.ride_pricing_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.users, public.driver_profiles, public.vehicles, public.driver_documents IN ACCESS SHARE MODE;
LOCK TABLE public.driver_score_events, public.driver_outreach_log, public.reviews,
  public.support_tickets, public.ticket_messages, public.lost_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.ride_disputes, public.incident_reports IN ACCESS SHARE MODE;

-- 1. Panel views -----------------------------------------------------------------------------
-- As in 00642: not security_invoker (the base tables' RLS would show marketing nothing), with
-- security_barrier and the admin-or-marketing gate in WHERE. Only SELECT is granted: through a
-- view that reads as its owner, a write would skip the base tables' RLS.
-- CREATE OR REPLACE keeps the existing columns first and in order; new ones go at the end.
CREATE OR REPLACE VIEW public.panel_rides
WITH (security_barrier = true, security_invoker = false) AS
SELECT r.id, r.created_at, r.status, r.customer_id, r.driver_id, r.service_type, r.city_id,
       r.estimated_fare_cup, r.final_fare_cup, r.final_fare_trc, r.payment_method,
       r.pickup_address, r.dropoff_address, r.promo_code_id, r.discount_amount_cup,
       r.shared_ride_discount_cup, r.dispatch_round,
       -- 00663
       r.ride_mode, r.is_scheduled, r.scheduled_at, r.accepted_at, r.driver_arrived_at, r.pickup_at,
       r.arrived_at_destination_at, r.completed_at, r.canceled_at, r.canceled_by,
       CASE
         WHEN r.status <> 'canceled' THEN NULL
         WHEN r.canceled_by IS NULL THEN 'system'
         WHEN r.canceled_by = r.customer_id THEN 'customer'
         WHEN EXISTS (SELECT 1 FROM public.driver_profiles d
                      WHERE d.id = r.driver_id AND d.user_id = r.canceled_by) THEN 'driver'
         ELSE 'staff'
       END AS canceled_by_role,
       r.cancellation_reason, r.cancellation_reason_code,
       r.estimated_distance_m, r.actual_distance_m, r.estimated_duration_s, r.actual_duration_s,
       r.wait_time_seconds, r.wait_charge_cup, r.passenger_count, r.shared_ride, r.is_split,
       r.corporate_account_id, r.partner_place_id, r.partner_discount_cup, r.tip_amount,
       r.surge_multiplier, r.driver_gps_status, r.searching_seen_at, r.last_dispatched_at,
       r.payment_status
FROM public.rides r
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- The vehicle comes through this view: since 00644 a SELECT policy on vehicles counts as a leak.
CREATE OR REPLACE VIEW public.panel_driver_profiles
WITH (security_barrier = true, security_invoker = false) AS
SELECT dp.id, dp.user_id, dp.is_online, dp.total_rides_completed, dp.total_rides,
       -- 00663
       dp.status, dp.rating_avg, dp.acceptance_rate, dp.total_rides_offered, dp.city_id, dp.zone_id,
       dp.municipality, dp.province, dp.created_at, dp.approved_at, dp.suspended_at,
       dp.suspended_reason, dp.is_on_break, dp.auto_accept_enabled, dp.last_heartbeat_at,
       dp.auto_offline_at, dp.terms_accepted_at,
       u.full_name, u.phone, u.email,
       v.type AS vehicle_type, v.plate_number, v.make AS vehicle_make, v.model AS vehicle_model,
       v.color AS vehicle_color, v.year AS vehicle_year
FROM public.driver_profiles dp
JOIN public.users u ON u.id = dp.user_id
LEFT JOIN LATERAL (
  SELECT vh.type, vh.plate_number, vh.make, vh.model, vh.color, vh.year
  FROM public.vehicles vh
  WHERE vh.driver_id = dp.id AND vh.is_active
  ORDER BY vh.created_at DESC, vh.id DESC
  LIMIT 1
) v ON true
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_driver_documents
WITH (security_barrier = true, security_invoker = false) AS
SELECT d.id, d.driver_id, d.document_type, d.uploaded_at, d.is_verified, d.verified_at, d.rejection_reason
FROM public.driver_documents d
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- driver_churn_risk is a security_invoker view. Postgres checks the tables under such a view as the
-- caller even when a view that is not security_invoker reads it, so the drivers' RLS would show
-- marketing no row. This function reads it as its owner, behind the same gate as the views, and
-- leaves the earnings out. Clients may call it: panel_driver_churn_risk does, and a view runs its
-- functions with the reader's EXECUTE privilege. It answers no row to anyone else.
CREATE OR REPLACE FUNCTION public._panel_driver_churn_risk()
RETURNS TABLE (driver_profile_id uuid, user_id uuid, full_name text, rating_avg numeric,
               total_rides_completed integer, acceptance_rate numeric, is_online boolean,
               status public.driver_status, days_since_last_ride integer, churn_risk_score integer,
               risk_level text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT c.driver_profile_id, c.user_id, c.full_name, c.rating_avg, c.total_rides_completed,
         c.acceptance_rate, c.is_online, c.status, c.days_since_last_ride, c.churn_risk_score, c.risk_level
  FROM public.driver_churn_risk c
  WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());
$fn$;
REVOKE ALL ON FUNCTION public._panel_driver_churn_risk() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._panel_driver_churn_risk() TO authenticated, service_role;

CREATE OR REPLACE VIEW public.panel_driver_churn_risk
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.driver_profile_id, c.user_id, c.full_name, c.rating_avg, c.total_rides_completed,
       c.acceptance_rate, c.is_online, c.status, c.days_since_last_ride, c.churn_risk_score, c.risk_level
FROM public._panel_driver_churn_risk() c
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_ride_disputes
WITH (security_barrier = true, security_invoker = false) AS
SELECT d.id, d.ride_id, d.opened_by, d.reason, d.description, d.status, d.priority,
       d.respondent_id, d.respondent_message, d.respondent_replied_at, d.resolution,
       d.resolution_notes, d.assigned_to, d.sla_first_response_at, d.sla_resolution_deadline,
       d.support_ticket_id, d.incident_report_id, d.created_at, d.updated_at, d.resolved_at
FROM public.ride_disputes d
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_incident_reports
WITH (security_barrier = true, security_invoker = false) AS
SELECT i.id, i.ride_id, i.reported_by, i.against_user_id, i.type, i.severity, i.description,
       i.status, i.resolved_by, i.resolved_at, i.created_at, i.updated_at, i.review_id
FROM public.incident_reports i
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- Until 2026-10-30 Supabase gives every new view of public ALL for the API roles: take it back,
-- then grant reading only. Written out per view: pnpm check:migration-grants skips dynamic SQL.
REVOKE ALL ON public.panel_rides FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_profiles FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_documents FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_churn_risk FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_ride_disputes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_incident_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.panel_rides TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_profiles TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_documents TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_churn_risk TO authenticated, service_role;
GRANT SELECT ON public.panel_ride_disputes TO authenticated, service_role;
GRANT SELECT ON public.panel_incident_reports TO authenticated, service_role;

COMMENT ON VIEW public.panel_rides IS
  'Rides as the admin panel reads them, for admins and marketing: no coordinates, share_token, notes or payment split (00642, 00663).';
COMMENT ON VIEW public.panel_driver_profiles IS
  'Driver profiles as the admin panel reads them, for admins and marketing: no GPS, identity, address, record or balance (00642, 00663).';
COMMENT ON VIEW public.panel_driver_documents IS
  'Which documents a driver uploaded and their review, for admins and marketing: no files (00663).';
COMMENT ON VIEW public.panel_driver_churn_risk IS
  'Driver churn risk for admins and marketing, without earnings (00663).';
COMMENT ON FUNCTION public._panel_driver_churn_risk() IS
  'driver_churn_risk read as its owner for admins and marketing, without earnings; no row for anyone else. Backs panel_driver_churn_risk (00663).';
COMMENT ON VIEW public.panel_ride_disputes IS
  'Disputes for admins and marketing: no evidence, refunds or admin notes (00663).';
COMMENT ON VIEW public.panel_incident_reports IS
  'Incident reports for admins and marketing: no evidence or resolution notes (00663).';

-- 2. Policies -------------------------------------------------------------------------------
DO $policies$
DECLARE
  c_m constant text := '(SELECT public.is_marketing())';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('reviews',                'reviews_select_marketing',                'SELECT', c_m,  NULL::text),
      ('support_tickets',        'support_tickets_select_marketing',        'SELECT', c_m,  NULL),
      ('support_tickets',        'support_tickets_update_marketing',        'UPDATE', c_m,  c_m),
      ('ticket_messages',        'ticket_messages_select_marketing',        'SELECT', c_m,  NULL),
      ('ticket_messages',        'ticket_messages_insert_marketing',        'INSERT', NULL, c_m || ' AND sender_id = (SELECT auth.uid())'),
      ('lost_items',             'lost_items_select_marketing',             'SELECT', c_m,  NULL),
      ('ride_transitions',       'ride_transitions_select_marketing',       'SELECT', c_m,  NULL),
      ('ride_pricing_snapshots', 'ride_pricing_snapshots_select_marketing', 'SELECT', c_m,  NULL),
      ('driver_score_events',    'driver_score_events_select_marketing',    'SELECT', c_m,  NULL),
      ('driver_outreach_log',    'driver_outreach_log_select_marketing',    'SELECT', c_m,  NULL)
    ) AS v(tbl, name, cmd, using_expr, check_expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.name) THEN
      EXECUTE format('CREATE POLICY %I ON public.%I FOR %s TO authenticated%s%s',
        r.name, r.tbl, r.cmd,
        CASE WHEN r.using_expr IS NULL THEN '' ELSE ' USING (' || r.using_expr || ')' END,
        CASE WHEN r.check_expr IS NULL THEN '' ELSE ' WITH CHECK (' || r.check_expr || ')' END);
    END IF;
  END LOOP;
END
$policies$;

-- 3 and 4a. Patches of live functions ---------------------------------------------------------
-- The read RPCs of the opened pages: their admin gate becomes "admin or marketing". The write
-- RPCs of those pages do not change.
-- tg_ticket_messages_client_guard: marketing's messages are support's, except in its own ticket.
-- Targets and replacements lose any \r, so a copy saved with CRLF patches to the same bodies.
DO $patch$
DECLARE
  r record;
  v_src text;
  v_md5 text;
  v_target text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.admin_incomplete_driver_signups()',
       '2841ccd9b2c3f9cb3804a361097e22d3', '65aad048b3031c8398c21cf3649bd47f',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_auto_accept_rate(integer)',
       'd287cc0735f48cb5d621d71b82bd0456', '6f20da2215bf11febeeba716589ca74a',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_auto_nav_rate(integer)',
       'ea732c6b23a1f3654f44d52077e3bd70', 'c763c447e0ac0d61f150757efc543bad',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.get_override_frequency(integer,integer)',
       '32d90734b10ec562591c9362b61f11a7', 'e7ad623472e2f8f2e180f05bf2c172fb',
       'IF NOT public.is_admin() THEN', 'IF NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.list_poi_submissions(text,integer,integer)',
       '6b1551aa33141886c0a9d0ac9a6bb616', '5bb221cc967fa33857a39ea963cd560c',
       'IF auth.uid() IS NULL OR NOT public.is_admin() THEN',
       'IF auth.uid() IS NULL OR NOT (public.is_admin() OR public.is_marketing()) THEN'),
      ('public.admin_list_pois(text,text,text,text,boolean,boolean,integer,integer)',
       'c4646cc85b1bd83c65bf11974d49fbfd', '0fd97f9da45bb7fddce9350acfec7fe6',
       $t$AND u.role IN ('admin','super_admin')$t$, $t$AND u.role IN ('admin','super_admin','marketing')$t$),
      ('public.tg_ticket_messages_client_guard()',
       '27dfd5fae754370a8554fd7c52f993cc', '96297a4de1f620d1e545e21643268224',
       $t$  NEW.is_admin := false;
$t$,
       $t$  -- Marketing answers tickets as support (00663), except in a ticket of its own.
  IF public.is_marketing() AND NOT EXISTS (
    SELECT 1 FROM public.support_tickets t WHERE t.id = NEW.ticket_id AND t.user_id = auth.uid()
  ) THEN
    NEW.is_admin := true;
  ELSE
    NEW.is_admin := false;
  END IF;
$t$)
    ) AS v(fn, old_md5, new_md5, target, repl)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00663: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    v_target := replace(r.target, chr(13), '');
    IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
      RAISE EXCEPTION '00663: the target is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), v_target, replace(r.repl, chr(13), ''));
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00663: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 4b. Support: what a client may change in a ticket ----------------------------------------
-- Admins keep "Admins update tickets" unchanged. Any other client (today only marketing has an
-- UPDATE policy) may change the status and nothing else; the server stamps the dates.
-- SECURITY INVOKER on purpose: current_user tells a client write from a function's.
CREATE OR REPLACE FUNCTION public.tg_support_tickets_client_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  c_free constant text[] := ARRAY['status', 'resolved_at', 'updated_at'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - c_free) IS DISTINCT FROM (to_jsonb(OLD) - c_free) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Solo puedes cambiar el estado del ticket.',
      DETAIL = 'ticket_column_staff_only';
  END IF;
  IF NEW.status IS NULL OR NEW.status NOT IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Ese estado de ticket no existe.',
      DETAIL = 'ticket_status_invalid';
  END IF;
  NEW.updated_at := now();
  IF NEW.status IN ('resolved', 'closed') THEN
    NEW.resolved_at := CASE WHEN OLD.status IN ('resolved', 'closed') THEN OLD.resolved_at ELSE now() END;
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.tg_support_tickets_client_update_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_support_tickets_client_update_guard
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_client_update_guard();

-- 5. Product failures -------------------------------------------------------------------------
-- What breaks for users, by period, for admins and marketing. No amounts, no user ids, no
-- coordinates: counts and reasons only.
CREATE OR REPLACE FUNCTION public.get_product_failures(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_days integer := LEAST(GREATEST(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := now() - make_interval(days => v_days);
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'days', v_days,
    -- Places riders typed that the app did not have (00584 queues them).
    'places_not_found', coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'searches', x.searches,
                                          'last_seen', x.last_seen, 'imported', x.imported)
                       ORDER BY x.searches DESC, x.last_seen DESC)
      FROM (
        SELECT q.name, count(*)::integer AS searches, max(q.created_at) AS last_seen,
               count(*) FILTER (WHERE q.status = 'done')::integer AS imported
        FROM public.poi_import_queue q
        WHERE q.created_at >= v_since
        GROUP BY q.name
        ORDER BY count(*) DESC, max(q.created_at) DESC
        LIMIT 50
      ) x), '[]'::jsonb),
    -- The last push registration outcome per account and app (00585), test accounts left out.
    'push_outcomes', coalesce((
      SELECT jsonb_agg(jsonb_build_object('app', x.app, 'outcome', x.outcome, 'users', x.users)
                       ORDER BY x.app, x.outcome)
      FROM (
        SELECT s.app, s.outcome, count(*)::integer AS users
        FROM public.push_registration_status s
        JOIN public.users u ON u.id = s.user_id
        WHERE NOT u.is_test
        GROUP BY s.app, s.outcome
      ) x), '[]'::jsonb),
    -- Of the people active in the period, how many have a device that can get a push.
    'push_reach', (
      SELECT jsonb_build_object(
        'riders_active', count(*),
        'riders_reachable', count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.user_devices d WHERE d.user_id = a.id)))
      FROM (
        SELECT DISTINCT r.customer_id AS id
        FROM public.rides r JOIN public.users u ON u.id = r.customer_id
        WHERE r.created_at >= v_since AND NOT u.is_test
      ) a
    ) || (
      SELECT jsonb_build_object(
        'drivers_active', count(*),
        'drivers_reachable', count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.user_devices d WHERE d.user_id = dp.user_id)))
      FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.last_heartbeat_at >= v_since AND NOT u.is_test
    ),
    -- App versions opened in the period (00622). Empty until a build that reports opens is out.
    'app_versions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('app', x.app, 'version', x.app_version,
                                          'platform', x.platform, 'installs', x.installs)
                       ORDER BY x.app, x.installs DESC)
      FROM (
        SELECT o.app, o.app_version, o.platform, count(*)::integer AS installs
        FROM public.app_opens o
        WHERE o.last_opened_at >= v_since
        GROUP BY o.app, o.app_version, o.platform
      ) x), '[]'::jsonb),
    -- Failed payments by reason: the provider's code, or the start of the error message.
    'failed_payments', coalesce((
      SELECT jsonb_agg(jsonb_build_object('reason', x.reason, 'payments', x.payments,
                                          'last_seen', x.last_seen)
                       ORDER BY x.payments DESC, x.last_seen DESC)
      FROM (
        SELECT coalesce(nullif(btrim(p.provider_error_code), ''),
                        left(coalesce(nullif(btrim(p.error_message), ''), 'sin motivo'), 60)) AS reason,
               count(*)::integer AS payments, max(p.created_at) AS last_seen
        FROM public.payment_intents p
        WHERE p.status = 'failed' AND p.created_at >= v_since
        GROUP BY 1
      ) x), '[]'::jsonb)
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.get_product_failures(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_product_failures(integer) TO authenticated, service_role;

-- 6. What this file promises ----------------------------------------------------------------
DO $check$
DECLARE
  c_hidden constant text[] := ARRAY[
    'share_token', 'share_token_expires_at', 'pickup_location', 'dropoff_location',
    'actual_dropoff_location', 'pickup_lat', 'pickup_lng', 'dropoff_lat', 'dropoff_lng',
    'current_location', 'current_heading', 'identity_number', 'address', 'has_criminal_record',
    'criminal_record_details', 'negative_balance_since', 'storage_path', 'file_name',
    'face_match_score', 'liveness_passed', 'evidence_urls', 'respondent_evidence_urls',
    'refund_amount_trc', 'refund_transaction_id', 'admin_notes', 'earnings_this_week',
    'earnings_last_week', 'pickup_notes', 'dropoff_notes', 'wallet_amount_cup', 'cash_amount_cup',
    'payment_intent_id'];
  c_guard constant regprocedure := 'public.tg_support_tickets_client_update_guard()'::regprocedure;
  c_pf constant regprocedure := 'public.get_product_failures(integer)'::regprocedure;
  c_churn constant regprocedure := 'public._panel_driver_churn_risk()'::regprocedure;
  v_fn regprocedure;
  v_name text;
  v_def text;
  v_tbl text;
  v_cmd text;
  v_pcmd text;
  v_roles name[];
  v_perm text;
  v_qual text;
  v_check text;
BEGIN
  -- No panel_ view in public carries a hidden column (by name: a column added later fails here).
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO v_def
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND c.relname LIKE 'panel\_%'
    AND a.attname = ANY (c_hidden);
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION '00663: % is a hidden column in a panel view', v_def;
  END IF;

  -- The six views: read as the owner behind the gate, readable only by authenticated and
  -- service_role, writable by none of them.
  FOREACH v_name IN ARRAY ARRAY['panel_rides', 'panel_driver_profiles', 'panel_driver_documents',
                                'panel_driver_churn_risk', 'panel_ride_disputes', 'panel_incident_reports'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                   WHERE oid = ('public.' || v_name)::regclass AND relkind = 'v'
                     AND reloptions @> ARRAY['security_barrier=true', 'security_invoker=false']) THEN
      RAISE EXCEPTION '00663: view % must be a security_barrier view that is not security_invoker', v_name;
    END IF;
    v_qual := pg_get_viewdef(('public.' || v_name)::regclass);
    IF position('is_admin()' IN v_qual) = 0 OR position('is_marketing()' IN v_qual) = 0 THEN
      RAISE EXCEPTION '00663: view % does not gate its rows on is_admin() or is_marketing()', v_name;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_name, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || v_name, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_name, 'SELECT')
       OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                  WHERE c.oid = ('public.' || v_name)::regclass
                    AND (a.grantee = 0
                         OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
                             AND a.privilege_type <> 'SELECT'))) THEN
      RAISE EXCEPTION '00663: view % must be readable by authenticated and service_role only, and writable by none of them', v_name;
    END IF;
  END LOOP;

  -- The policies: PERMISSIVE, TO authenticated, using is_marketing().
  FOR v_tbl, v_name, v_cmd IN
    SELECT * FROM (VALUES
      ('reviews', 'reviews_select_marketing', 'SELECT'),
      ('support_tickets', 'support_tickets_select_marketing', 'SELECT'),
      ('support_tickets', 'support_tickets_update_marketing', 'UPDATE'),
      ('ticket_messages', 'ticket_messages_select_marketing', 'SELECT'),
      ('ticket_messages', 'ticket_messages_insert_marketing', 'INSERT'),
      ('lost_items', 'lost_items_select_marketing', 'SELECT'),
      ('ride_transitions', 'ride_transitions_select_marketing', 'SELECT'),
      ('ride_pricing_snapshots', 'ride_pricing_snapshots_select_marketing', 'SELECT'),
      ('driver_score_events', 'driver_score_events_select_marketing', 'SELECT'),
      ('driver_outreach_log', 'driver_outreach_log_select_marketing', 'SELECT')
    ) AS v(t, n, c)
  LOOP
    SELECT p.cmd, p.roles, p.permissive, coalesce(p.qual, ''), coalesce(p.with_check, '')
      INTO v_pcmd, v_roles, v_perm, v_qual, v_check
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.policyname = v_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION '00663: policy % on % is missing', v_name, v_tbl;
    END IF;
    IF (v_cmd IN ('SELECT', 'UPDATE') AND position('is_marketing()' IN v_qual) = 0)
       OR (v_cmd IN ('INSERT', 'UPDATE') AND position('is_marketing()' IN v_check) = 0) THEN
      RAISE EXCEPTION '00663: policy % on % does not use is_marketing()', v_name, v_tbl;
    END IF;
    IF v_pcmd <> v_cmd OR v_roles <> ARRAY['authenticated']::name[] OR v_perm <> 'PERMISSIVE' THEN
      RAISE EXCEPTION '00663: policy % on % must be PERMISSIVE FOR % TO authenticated (it is % FOR % TO %)',
        v_name, v_tbl, v_cmd, v_perm, v_pcmd, v_roles;
    END IF;
  END LOOP;
  SELECT coalesce(with_check, '') INTO v_check FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'ticket_messages' AND policyname = 'ticket_messages_insert_marketing';
  IF v_check !~ 'sender_id = \( SELECT auth\.uid\(\)' THEN
    RAISE EXCEPTION '00663: policy ticket_messages_insert_marketing does not tie sender_id to auth.uid()';
  END IF;

  -- Tables marketing reads only through the panel views, or not at all.
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_def FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('rides', 'driver_profiles', 'vehicles', 'driver_documents', 'ride_disputes',
                      'incident_reports', 'wallet_accounts', 'ledger_entries', 'ledger_transactions',
                      'wallet_transfers', 'payment_intents', 'ride_messages', 'delivery_details',
                      'selfie_checks', 'driver_contracts', 'user_devices')
    AND (position('is_marketing' IN coalesce(qual, '')) > 0
         OR position('is_marketing' IN coalesce(with_check, '')) > 0);
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION '00663: % let marketing read a table it must reach only through the panel views', v_def;
  END IF;

  -- The patched bodies.
  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('public.admin_incomplete_driver_signups()', '65aad048b3031c8398c21cf3649bd47f'),
      ('public.get_auto_accept_rate(integer)', '6f20da2215bf11febeeba716589ca74a'),
      ('public.get_auto_nav_rate(integer)', 'c763c447e0ac0d61f150757efc543bad'),
      ('public.get_override_frequency(integer,integer)', 'e7ad623472e2f8f2e180f05bf2c172fb'),
      ('public.list_poi_submissions(text,integer,integer)', '5bb221cc967fa33857a39ea963cd560c'),
      ('public.admin_list_pois(text,text,text,text,boolean,boolean,integer,integer)', '0fd97f9da45bb7fddce9350acfec7fe6'),
      ('public.tg_ticket_messages_client_guard()', '96297a4de1f620d1e545e21643268224')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) <> v_def THEN
      RAISE EXCEPTION '00663: % does not have the patched body', v_name;
    END IF;
  END LOOP;

  -- The support guard: invoker, on every UPDATE of support_tickets, row by row, enabled.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = c_guard) THEN
    RAISE EXCEPTION '00663: tg_support_tickets_client_update_guard() must be SECURITY INVOKER';
  END IF;
  -- tgtype bits: ROW 1, BEFORE 2, UPDATE 16.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.support_tickets'::regclass
                   AND tgname = 'trg_support_tickets_client_update_guard'
                   AND tgfoid = c_guard AND tgenabled = 'O' AND tgtype = (1 | 2 | 16)
                   AND cardinality(tgattr::int2[]) = 0 AND tgqual IS NULL) THEN
    RAISE EXCEPTION '00663: trg_support_tickets_client_update_guard must fire BEFORE UPDATE FOR EACH ROW on support_tickets, on every column, enabled';
  END IF;

  -- get_product_failures() and _panel_driver_churn_risk(): definers with an empty search_path
  -- that answer admins and marketing only, return no hidden column, and are executable by
  -- authenticated and the service role only.
  FOREACH v_fn IN ARRAY ARRAY[c_pf, c_churn] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc
                   WHERE oid = v_fn AND prosecdef AND proconfig = ARRAY['search_path=""']) THEN
      RAISE EXCEPTION '00663: % must be SECURITY DEFINER with search_path = ''''', v_fn;
    END IF;
    IF (SELECT position('public.is_admin()' IN prosrc) = 0 OR position('public.is_marketing()' IN prosrc) = 0
        FROM pg_proc WHERE oid = v_fn) THEN
      RAISE EXCEPTION '00663: % does not gate on is_admin() and is_marketing()', v_fn;
    END IF;
    IF (SELECT coalesce(proargnames && c_hidden, false) FROM pg_proc WHERE oid = v_fn) THEN
      RAISE EXCEPTION '00663: % returns a hidden column', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '00663: % must be executable by authenticated and service_role, not by anon or PUBLIC', v_fn;
    END IF;
  END LOOP;
END
$check$;

RESET lock_timeout;
