-- ============================================================
-- 00642 — marketing role: what a marketing account may read and write
--
-- Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
-- Needs 00641 (the enum value) committed first: a value added by ALTER TYPE cannot be used in
-- the transaction that adds it.
--
--   1. is_marketing(): the twin of is_admin() (00592), anon-safe.
--   2. Promotions: approval columns, a content revision and a draft-and-approve trigger.
--      Marketing creates and edits drafts; only an admin or super_admin turns a promotion on, and
--      that stamps the approval. The panel approves the revision the admin saw, and nothing newer.
--   3. Policies, all named *_marketing so a rollback can drop exactly these. Nothing that exists
--      today is loosened for any other role.
--   4. panel_rides and panel_driver_profiles: what the panel lists of rides and drivers, for
--      admins and marketing, without the ride share token or the drivers' live GPS.
--   5. The metrics RPCs the marketing pages call let marketing through their admin gate, and
--      count_power_users counts riders through panel_rides.
--   6. Three live functions that list roles learn about marketing: it rides as a passenger, keeps
--      its role when approved as a driver, and gets its passenger rating.
--   7. Checks of everything above. A failed check aborts the whole file.
--
-- Every function patch starts from the live body, runs only on the body this file was written
-- against (md5 below), is skipped on the body it leaves, and refuses any other body.
-- No statement here drops or removes anything.
--
-- Rehearsal: supabase/tests/00642/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table. Waiting behind a long transaction would queue the app's
-- reads behind us; failing fast and retrying is better.
SET lock_timeout = '5s';

-- Every table this file touches, locked up front in the order the app takes them (a ride first,
-- then its users and driver profiles), instead of one by one in whatever order the statements
-- below reach them. Each gets the lock the file needs anyway: ACCESS EXCLUSIVE where it creates a
-- policy or alters the table, ACCESS SHARE where it only reads it (the panel views and
-- promotion_is_referenced). ACCESS SHARE blocks no reader or writer.
-- That makes a deadlock with live traffic unlikely, not impossible: a query can hold one of these
-- tables and then need another through a policy subquery (an anon read of blog_posts reaches users
-- that way) while this file holds the second and waits for the first. Postgres breaks the cycle
-- by aborting one side. When that is this file (40P01, deadlock), or when the file gives up waiting
-- (55P03, the lock_timeout above), the whole file rolls back cleanly, since it runs in one
-- transaction, and the fix is to run it again.
-- LOCK TABLE needs a transaction: apply_migration and db push run the file in one.
LOCK TABLE public.rides IN ACCESS SHARE MODE;
LOCK TABLE public.users IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.driver_profiles IN ACCESS SHARE MODE;
LOCK TABLE public.referrals, public.promotions, public.campaigns, public.home_announcements,
  public.blog_posts, public.acquisition_codes IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.promotion_uses IN ACCESS SHARE MODE;

-- 1. is_marketing() -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_marketing()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$$;
REVOKE ALL ON FUNCTION public.is_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon, authenticated, service_role;

-- 2. Promotions: draft and approval ---------------------------------------------------------
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.promotions.pending_approval IS
  'true while a promotion created or edited by marketing waits for an admin to turn it on (00642).';
COMMENT ON COLUMN public.promotions.revision IS
  'Counts changes to what a promotion offers. Only its trigger writes it. The panel approves with '
  '"WHERE revision = <the one the admin saw> AND NOT is_active", so an edit made while the admin '
  'was looking matches no row (00642).';

-- Whether anything points at a promotion. The guard below asks it before marketing deletes one:
-- the guard runs as the caller, and RLS hides most of these rows from marketing. It answers
-- true or false and nothing else, and only to marketing and the admins: anyone else gets false,
-- so it tells nobody else which promotions were used.
CREATE OR REPLACE FUNCTION public.promotion_is_referenced(p_promotion_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN NOT (public.is_marketing() OR public.is_admin()) THEN false
    ELSE EXISTS (SELECT 1 FROM public.rides WHERE promo_code_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.promotion_uses WHERE promotion_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.campaigns WHERE promo_code_id = p_promotion_id)
  END;
$$;
REVOKE ALL ON FUNCTION public.promotion_is_referenced(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.promotion_is_referenced(uuid) TO authenticated;

-- SECURITY INVOKER on purpose: the marketing test reads current_user, which inside a SECURITY
-- DEFINER function is always its owner.
CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $$
DECLARE
  -- What the approval and the use counter write. Every other column is content: changing it
  -- makes a new revision, one no admin has seen yet.
  c_bookkeeping constant text[] := ARRAY['is_active', 'notified_at', 'pending_approval',
    'approved_by', 'approved_at', 'current_uses', 'revision', 'created_at'];
  v_marketing boolean;
BEGIN
  -- Marketing's rules bind marketing's own writes through the API, nothing else. A ride claims
  -- a promotion use (tg_rides_validate_promo_discount) and gives it back on cancel
  -- (tg_rides_rollback_promo_on_cancel) inside SECURITY DEFINER triggers, with the passenger's
  -- JWT still set. There current_user is their owner, so a marketing account rides with a
  -- promo code like anyone else.
  v_marketing := current_user IN ('anon', 'authenticated') AND public.is_marketing();

  IF TG_OP = 'DELETE' THEN
    -- Only a paused promotion that nothing points at. Deleting one that a ride, a use or a
    -- campaign still names would rewrite their history (the foreign keys set it to NULL).
    IF v_marketing AND (OLD.is_active OR OLD.current_uses > 0
                        OR public.promotion_is_referenced(OLD.id)) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Solo se puede borrar una promoción pausada que nadie usó.',
        DETAIL = 'promo_delete_blocked';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.revision := 0;
    IF v_marketing THEN
      -- A draft, whatever the request says. Only an admin turns it on.
      NEW.is_active := false;
      NEW.pending_approval := true;
      NEW.created_by := auth.uid();
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.current_uses := 0;
      NEW.notified_at := NULL;
    END IF;
  ELSE
    -- Nobody writes the revision. It only counts content changes (below).
    NEW.revision := OLD.revision;
    IF v_marketing AND OLD.is_active THEN
      -- A live promotion: marketing may pause it, or stamp the push "Notificar ahora" just sent.
      IF (to_jsonb(NEW) - 'is_active' - 'notified_at') IS DISTINCT FROM (to_jsonb(OLD) - 'is_active' - 'notified_at') THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Pausa la promoción para editarla.',
          DETAIL = 'promo_active_locked';
      END IF;
    ELSIF v_marketing THEN
      IF NEW.is_active THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Solo un administrador puede activar una promoción.',
          DETAIL = 'promo_activation_requires_admin';
      END IF;
      -- Marketing never writes the approval or the counters. Nor the push stamp of a promotion
      -- that is off: "Notificar ahora" is for live ones, and a stamp on a draft would decide
      -- whether its approval sends the publish push.
      NEW.pending_approval := OLD.pending_approval;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.created_by := OLD.created_by;
      NEW.current_uses := OLD.current_uses;
      NEW.notified_at := OLD.notified_at;
    END IF;
    IF (to_jsonb(NEW) - c_bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - c_bookkeeping) THEN
      NEW.revision := OLD.revision + 1;
      -- A draft marketing edited goes back to the admins. A marketing write that changes nothing
      -- it offers (a second pause, a stale save) leaves the wait as it was.
      IF v_marketing THEN
        NEW.pending_approval := true;
      END IF;
    END IF;
  END IF;

  -- Turning a promotion on, by anyone, ends its wait for approval. Only an admin's or
  -- super_admin's activation is an approval and gets the stamp; the service role, cron and SQL
  -- without a JWT turn it on unstamped.
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    NEW.pending_approval := false;
    IF public.is_admin() THEN
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_promotions_marketing_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_promotions_marketing_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.promotions
  FOR EACH ROW EXECUTE FUNCTION public.tg_promotions_marketing_guard();

-- 3. Policies -------------------------------------------------------------------------------
-- Additive only: each one lets marketing do what its pages need. A policy that already exists
-- with the same name is kept, and section 7 checks it.
DO $policies$
DECLARE
  c_m constant text := '(SELECT public.is_marketing())';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Reading, for the campaign segments and the referral list. Rides and driver profiles
      -- get no policy: marketing reads them through the panel views (section 4), which leave out
      -- the live-tracking token and the drivers' GPS.
      ('users',              'users_select_marketing',           'SELECT', c_m,  NULL::text),
      ('referrals',          'referrals_select_marketing',       'SELECT', c_m,  NULL),
      -- Promotions: the trigger above decides what a write may change.
      ('promotions',         'promotions_select_marketing',      'SELECT', c_m,  NULL),
      ('promotions',         'promotions_insert_marketing',      'INSERT', NULL, c_m),
      ('promotions',         'promotions_update_marketing',      'UPDATE', c_m,  c_m),
      ('promotions',         'promotions_delete_marketing',      'DELETE', c_m,  NULL),
      -- Campaigns: the page reads them and inserts its own.
      ('campaigns',          'campaigns_select_marketing',       'SELECT', c_m,  NULL),
      ('campaigns',          'campaigns_insert_marketing',       'INSERT', NULL, c_m || ' AND created_by = (SELECT auth.uid())'),
      -- Content and signup codes: full control, like the admins.
      ('home_announcements', 'home_announcements_all_marketing', 'ALL',    c_m,  c_m),
      ('blog_posts',         'blog_posts_all_marketing',         'ALL',    c_m,  c_m),
      ('acquisition_codes',  'acquisition_codes_all_marketing',  'ALL',    c_m,  c_m)
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

-- 4. Panel views ----------------------------------------------------------------------------
-- RLS hides rows, never columns, so a SELECT policy on rides or driver_profiles would also hand
-- marketing every ride's share_token (live tracking of a trip in progress) and every driver's
-- GPS (current_location, current_heading, last_heartbeat_at). The panel reads these two views
-- instead, for admins and marketing alike; they carry exactly the columns its pages use.
--
-- Not security_invoker, on purpose, against the rule for new views (00294): as the invoker,
-- the base tables' RLS would show marketing only its own rides. The views read as their owner,
-- and the gate in WHERE is what decides who sees rows: an admin or marketing, nobody else.
-- security_barrier keeps a caller's own conditions from being evaluated before that gate.
-- SELECT is the only privilege granted: through a view that reads as its owner, an UPDATE or
-- DELETE would skip the base tables' RLS.
CREATE OR REPLACE VIEW public.panel_rides
WITH (security_barrier = true, security_invoker = false) AS
SELECT r.id, r.created_at, r.status, r.customer_id, r.driver_id, r.service_type, r.city_id,
       r.estimated_fare_cup, r.final_fare_cup, r.final_fare_trc, r.payment_method,
       r.pickup_address, r.dropoff_address, r.promo_code_id, r.discount_amount_cup,
       r.shared_ride_discount_cup, r.dispatch_round
FROM public.rides r
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

CREATE OR REPLACE VIEW public.panel_driver_profiles
WITH (security_barrier = true, security_invoker = false) AS
SELECT dp.id, dp.user_id, dp.is_online, dp.total_rides_completed, dp.total_rides
FROM public.driver_profiles dp
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());

-- Until 2026-10-30 Supabase gives every new view of public ALL for the API roles: take it back,
-- then grant reading only.
REVOKE ALL ON public.panel_rides FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.panel_driver_profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.panel_rides TO authenticated, service_role;
GRANT SELECT ON public.panel_driver_profiles TO authenticated, service_role;

COMMENT ON VIEW public.panel_rides IS
  'Rides as the admin panel lists them, for admins and marketing: no share_token (00642).';
COMMENT ON VIEW public.panel_driver_profiles IS
  'Driver profiles as the admin panel lists them, for admins and marketing: no GPS (00642).';

-- 5. Metrics RPCs ---------------------------------------------------------------------------
-- The admin gate of each one becomes "admin or marketing". Two spellings exist in prod; the
-- whole condition is replaced, never just is_admin() (that would leave "public.(...)").
-- get_platform_earnings stays admin-only: only /earnings calls it.
DO $patch$
DECLARE
  c_gate constant text := 'IF NOT (public.is_admin() OR public.is_marketing()) THEN';
  r record;
  v_src text;
  v_md5 text;
  v_target text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.admin_launch_pulse(integer)',          '21c359c7427f75016c38b6b758ad23a7', 'bb5d37a5bca57a64d3e3409ada2dd6b6'),
      ('public.admin_signup_code_stats()',            '079bc5a6c046e6896c62200f71fc7740', '16a8ed1ebe03aa82f2f75676783a9099'),
      ('public.get_admin_dashboard_metrics()',        '0c99d4e89b08ad2da5989642e09ba5bf', '32cec76d3f079f6938b09f8bb7e919b2'),
      ('public.get_admin_wallet_stats()',             '86c6ef03c7c39d56e9f84cc8795dfbfd', '0f937c94cda1d26e7dd2da7d574949dd'),
      ('public.get_rides_by_day(integer)',            '68dcc98aaa0919c942eafc22e6cfe06a', 'fd5363b072a17da61325a23cfd1486af'),
      ('public.get_rides_by_service_type(integer)',   'c94b1028a03b16d34d25f4a2a56d4bd6', 'ffd6c633752a21bba4945625fc9aaaaf'),
      ('public.get_rides_by_payment_method(integer)', '351484791e08451565cc6fbae34fef2e', '2ecacefdfef6c96da84d3b2f20a0b138'),
      ('public.get_top_drivers(integer)',             'cb273bf7da9f5c3d58b495ba08d6714b', '03e7be0213769612782ed3bcb0183f3a'),
      ('public.get_active_push_user_ids(integer)',    'e3d6f508efe28decb7141f3251410f50', '875f787da6a1c0fcce8708404efd72d8')
    ) AS v(fn, old_md5, new_md5)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00642: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    v_target := CASE WHEN position('IF NOT public.is_admin() THEN' IN v_src) > 0
                     THEN 'IF NOT public.is_admin() THEN' ELSE 'IF NOT is_admin() THEN' END;
    IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
      RAISE EXCEPTION '00642: the admin gate is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), v_target, c_gate);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00642: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- count_power_users has no gate: it runs as its caller (SECURITY INVOKER) and counts the rides
-- RLS shows them, so marketing, with no policy on rides, counted only its own. It reads the
-- panel view instead: admins and marketing count every rider, anyone else counts none. A
-- customer and the service role without a JWT get 0; anon, with no SELECT on the view, gets a
-- permission error. It stays SECURITY INVOKER, as in prod. Only /segments calls it, signed in.
DO $patch$
DECLARE
  c_fn constant regprocedure := 'public.count_power_users(integer)'::regprocedure;
  c_old_md5 constant text := 'd03f94845bb47efb8183fba60754012d';
  c_new_md5 constant text := '40b9c404e71ac2ef26042fe75bc955bc';
  c_target constant text := 'FROM rides';
  v_src text;
  v_md5 text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_fn;
  v_md5 := md5(v_src);
  IF v_md5 = c_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 <> c_old_md5 THEN
    RAISE EXCEPTION '00642: % has a body this file does not know (md5 %); patch it from the live body', c_fn, v_md5;
  END IF;
  IF (length(v_src) - length(replace(v_src, c_target, ''))) / length(c_target) <> 1 THEN
    RAISE EXCEPTION '00642: % does not read rides exactly once', c_fn;
  END IF;
  EXECUTE replace(pg_get_functiondef(c_fn), c_target, 'FROM public.panel_rides');
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 <> c_new_md5 THEN
    RAISE EXCEPTION '00642: % patched to an unexpected body (md5 %)', c_fn, v_md5;
  END IF;
END
$patch$;

-- 6. Live functions that list roles ---------------------------------------------------------
DO $patch$
DECLARE
  r record;
  v_src text;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- valid_transitions lists customer, driver, admin and super_admin. Marketing rides as a
      -- passenger: without this it could not even cancel its own search.
      ('public.enforce_ride_transition()',
       '35bde4fd60a4a4fa0fc86a237ec4a414', 'f806997fab31c18e7b369e69f5321c30',
       $t$  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();
$t$,
       $t$  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Marketing rides as a passenger: its rights over a ride are a customer's
  -- (or a driver's, below, when it owns the approved driver profile).
  IF v_user_role = 'marketing' THEN
    v_user_role := 'customer';
  END IF;
$t$),
      -- Approving a driver profile turned every other role into 'driver'. Marketing keeps its
      -- role, as admins do.
      ('public.ensure_driver_role_and_tricicoin_on_approval()',
       'ed41bc2fe192ceb6dbafd163507934f3', '1940d4379a446c8afdf0d47434945c07',
       $t$role NOT IN ('driver', 'admin', 'super_admin')$t$,
       $t$role NOT IN ('driver', 'admin', 'super_admin', 'marketing')$t$),
      -- A marketing passenger gets its rating, like customers and admins.
      ('public.apply_user_rating(uuid)',
       '8d0b0de3bf82f6d15d8da36462cbbe9c', '96be8c154990651738312ef44861242f',
       $t$v_role IN ('customer', 'super_admin', 'admin')$t$,
       $t$v_role IN ('customer', 'super_admin', 'admin', 'marketing')$t$)
    ) AS v(fn, old_md5, new_md5, target, repl)
  LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = r.fn::regprocedure;
    v_md5 := md5(v_src);
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00642: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    IF (length(v_src) - length(replace(v_src, r.target, ''))) / length(r.target) <> 1 THEN
      RAISE EXCEPTION '00642: the role list is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), r.target, r.repl);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00642: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 7. What this file promises ----------------------------------------------------------------
DO $check$
DECLARE
  c_guard constant regprocedure := 'public.tg_promotions_marketing_guard()'::regprocedure;
  c_ref constant regprocedure := 'public.promotion_is_referenced(uuid)'::regprocedure;
  v_tbl text;
  v_name text;
  v_def text;
  v_cmd text;
  v_pcmd text;
  v_roles name[];
  v_perm text;
  v_qual text;
  v_check text;
BEGIN
  -- is_marketing(): invoker, callable by the API roles (policies call it), false without a JWT.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_marketing()'::regprocedure) THEN
    RAISE EXCEPTION '00642: is_marketing() must not be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('anon', 'public.is_marketing()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_marketing()', 'EXECUTE') THEN
    RAISE EXCEPTION '00642: anon and authenticated must be able to call is_marketing()';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE anon;
  IF public.is_marketing() THEN
    RAISE EXCEPTION '00642: is_marketing() is true without a JWT';
  END IF;
  RESET ROLE;

  -- The guard reads current_user to tell marketing's own writes from the ride triggers' writes:
  -- as a SECURITY DEFINER it would always see its owner.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = c_guard) THEN
    RAISE EXCEPTION '00642: tg_promotions_marketing_guard() must be SECURITY INVOKER';
  END IF;
  -- On every write to promotions, row by row: no event, column list or WHEN missing, enabled.
  -- tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16 (TRUNCATE 32, INSTEAD 64).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.promotions'::regclass
                   AND tgname = 'trg_promotions_marketing_guard'
                   AND tgfoid = c_guard
                   AND tgenabled = 'O'
                   AND tgtype = (1 | 2 | 4 | 8 | 16)
                   AND cardinality(tgattr::int2[]) = 0
                   AND tgqual IS NULL) THEN
    RAISE EXCEPTION '00642: trg_promotions_marketing_guard must fire BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW on promotions, on every column, enabled';
  END IF;

  -- promotion_is_referenced(): a definer with an empty search_path, callable by authenticated only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = c_ref AND prosecdef AND proconfig = ARRAY['search_path=""']) THEN
    RAISE EXCEPTION '00642: promotion_is_referenced(uuid) must be SECURITY DEFINER with search_path = ''''';
  END IF;
  IF NOT has_function_privilege('authenticated', c_ref, 'EXECUTE')
     OR has_function_privilege('anon', c_ref, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = c_ref AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '00642: promotion_is_referenced(uuid) must be executable by authenticated and not by anon or PUBLIC';
  END IF;

  FOR v_tbl, v_name, v_cmd IN
    SELECT * FROM (VALUES
      ('users', 'users_select_marketing', 'SELECT'),
      ('referrals', 'referrals_select_marketing', 'SELECT'),
      ('promotions', 'promotions_select_marketing', 'SELECT'),
      ('promotions', 'promotions_insert_marketing', 'INSERT'),
      ('promotions', 'promotions_update_marketing', 'UPDATE'),
      ('promotions', 'promotions_delete_marketing', 'DELETE'),
      ('campaigns', 'campaigns_select_marketing', 'SELECT'),
      ('campaigns', 'campaigns_insert_marketing', 'INSERT'),
      ('home_announcements', 'home_announcements_all_marketing', 'ALL'),
      ('blog_posts', 'blog_posts_all_marketing', 'ALL'),
      ('acquisition_codes', 'acquisition_codes_all_marketing', 'ALL')
    ) AS v(t, n, c)
  LOOP
    SELECT p.cmd, p.roles, p.permissive, coalesce(p.qual, ''), coalesce(p.with_check, '')
      INTO v_pcmd, v_roles, v_perm, v_qual, v_check
    FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_tbl AND p.policyname = v_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION '00642: policy % on % is missing', v_name, v_tbl;
    END IF;
    IF (v_cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL') AND position('is_marketing()' IN v_qual) = 0)
       OR (v_cmd IN ('INSERT', 'UPDATE', 'ALL') AND position('is_marketing()' IN v_check) = 0) THEN
      RAISE EXCEPTION '00642: policy % on % does not use is_marketing()', v_name, v_tbl;
    END IF;
    IF v_pcmd <> v_cmd THEN
      RAISE EXCEPTION '00642: policy % on % is FOR %, not FOR %', v_name, v_tbl, v_pcmd, v_cmd;
    END IF;
    IF v_roles <> ARRAY['authenticated']::name[] OR v_perm <> 'PERMISSIVE' THEN
      RAISE EXCEPTION '00642: policy % on % must be PERMISSIVE and TO authenticated only (it is % TO %)',
        v_name, v_tbl, v_perm, v_roles;
    END IF;
  END LOOP;
  -- Marketing reads rides and driver profiles through the panel views only: a policy on either
  -- table would show it the share token and the drivers' GPS.
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO v_def FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('rides', 'driver_profiles')
    AND (position('is_marketing' IN coalesce(qual, '')) > 0
         OR position('is_marketing' IN coalesce(with_check, '')) > 0);
  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION '00642: % let marketing read rides or driver_profiles directly; it must use the panel views', v_def;
  END IF;

  -- The panel views: exactly their columns, read as the owner behind the admin-or-marketing
  -- gate, and readable (only) by authenticated and service_role.
  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('panel_rides', 'id,created_at,status,customer_id,driver_id,service_type,city_id,'
        || 'estimated_fare_cup,final_fare_cup,final_fare_trc,payment_method,pickup_address,'
        || 'dropoff_address,promo_code_id,discount_amount_cup,shared_ride_discount_cup,dispatch_round'),
      ('panel_driver_profiles', 'id,user_id,is_online,total_rides_completed,total_rides')
    ) AS v(n, cols)
  LOOP
    IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = ('public.' || v_name)::regclass AND attnum > 0 AND NOT attisdropped)
       IS DISTINCT FROM v_def THEN
      RAISE EXCEPTION '00642: view % must have exactly the columns %', v_name, v_def;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class
                   WHERE oid = ('public.' || v_name)::regclass AND relkind = 'v'
                     AND reloptions @> ARRAY['security_barrier=true', 'security_invoker=false']) THEN
      RAISE EXCEPTION '00642: view % must be a security_barrier view that is not security_invoker', v_name;
    END IF;
    v_qual := pg_get_viewdef(('public.' || v_name)::regclass);
    IF position('is_admin()' IN v_qual) = 0 OR position('is_marketing()' IN v_qual) = 0 THEN
      RAISE EXCEPTION '00642: view % does not gate its rows on is_admin() or is_marketing()', v_name;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_name, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || v_name, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_name, 'SELECT')
       OR EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
                  WHERE c.oid = ('public.' || v_name)::regclass
                    AND (a.grantee = 0
                         OR (a.grantee IN ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
                             AND a.privilege_type <> 'SELECT'))) THEN
      RAISE EXCEPTION '00642: view % must be readable by authenticated and service_role only, and writable by none of them', v_name;
    END IF;
  END LOOP;

  -- Marketing inserts campaigns in its own name only.
  SELECT coalesce(with_check, '') INTO v_check FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'campaigns' AND policyname = 'campaigns_insert_marketing';
  IF v_check !~ 'created_by = \( SELECT auth\.uid\(\)' THEN
    RAISE EXCEPTION '00642: policy campaigns_insert_marketing does not tie created_by to auth.uid()';
  END IF;

  FOR v_name, v_def IN
    SELECT * FROM (VALUES
      ('public.admin_launch_pulse(integer)', 'bb5d37a5bca57a64d3e3409ada2dd6b6'),
      ('public.admin_signup_code_stats()', '16a8ed1ebe03aa82f2f75676783a9099'),
      ('public.get_admin_dashboard_metrics()', '32cec76d3f079f6938b09f8bb7e919b2'),
      ('public.get_admin_wallet_stats()', '0f937c94cda1d26e7dd2da7d574949dd'),
      ('public.get_rides_by_day(integer)', 'fd5363b072a17da61325a23cfd1486af'),
      ('public.get_rides_by_service_type(integer)', 'ffd6c633752a21bba4945625fc9aaaaf'),
      ('public.get_rides_by_payment_method(integer)', '2ecacefdfef6c96da84d3b2f20a0b138'),
      ('public.get_top_drivers(integer)', '03e7be0213769612782ed3bcb0183f3a'),
      ('public.get_active_push_user_ids(integer)', '875f787da6a1c0fcce8708404efd72d8'),
      ('public.count_power_users(integer)', '40b9c404e71ac2ef26042fe75bc955bc'),
      ('public.enforce_ride_transition()', 'f806997fab31c18e7b369e69f5321c30'),
      ('public.ensure_driver_role_and_tricicoin_on_approval()', '1940d4379a446c8afdf0d47434945c07'),
      ('public.apply_user_rating(uuid)', '96be8c154990651738312ef44861242f')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) <> v_def THEN
      RAISE EXCEPTION '00642: % does not have the patched body', v_name;
    END IF;
  END LOOP;

  -- count_power_users stays as prod has it, SECURITY INVOKER: it counts what panel_rides shows
  -- its caller, and a caller with no SELECT on the view (anon) gets no answer.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.count_power_users(integer)'::regprocedure) THEN
    RAISE EXCEPTION '00642: count_power_users(integer) must stay SECURITY INVOKER';
  END IF;
END
$check$;

RESET lock_timeout;
