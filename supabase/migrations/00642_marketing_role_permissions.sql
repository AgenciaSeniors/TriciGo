-- ============================================================
-- 00641 — marketing role: what a marketing account may read and write
--
-- Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
-- Needs 00640 (the enum value) committed first: a value added by ALTER TYPE cannot be used in
-- the transaction that adds it.
--
--   1. is_marketing(): the twin of is_admin() (00592), anon-safe.
--   2. Promotions: approval columns and a draft-and-approve trigger. Marketing creates and edits
--      drafts; only an admin or super_admin turns a promotion on, and that stamps the approval.
--   3. Policies, all named *_marketing so a rollback can drop exactly these. Nothing that exists
--      today is loosened for any other role.
--   4. The metrics RPCs the marketing pages call let marketing through their admin gate.
--   5. Three live functions that list roles learn about marketing: it rides as a passenger, keeps
--      its role when approved as a driver, and gets its passenger rating.
--   6. Checks of everything above. A failed check aborts the whole file.
--
-- Every function patch starts from the live body, runs only on the body this file was written
-- against (md5 below), is skipped on the body it leaves, and refuses any other body.
-- No statement here drops or removes anything.
--
-- Rehearsal: supabase/tests/00641/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- Creating a policy locks its table. Waiting behind a long transaction would queue the app's
-- reads behind us; failing fast and retrying is better.
SET lock_timeout = '5s';

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
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.promotions.pending_approval IS
  'true while a promotion created or edited by marketing waits for an admin to turn it on (00641).';

CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF public.is_admin() THEN
    -- An admin or super_admin turning a promotion on: that is the approval.
    IF TG_OP <> 'DELETE' AND NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
      NEW.pending_approval := false;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    END IF;
  ELSIF public.is_marketing() THEN
    IF TG_OP = 'INSERT' THEN
      -- A draft, whatever the request says. Only an admin turns it on.
      NEW.is_active := false;
      NEW.pending_approval := true;
      NEW.created_by := auth.uid();
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.current_uses := 0;
      NEW.notified_at := NULL;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active THEN
      -- A live promotion: marketing may pause it, or stamp the push "Notificar ahora" just sent.
      IF (to_jsonb(NEW) - 'is_active' - 'notified_at') IS DISTINCT FROM (to_jsonb(OLD) - 'is_active' - 'notified_at') THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Pausa la promoción para editarla.',
          DETAIL = 'promo_active_locked';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.is_active THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'Solo un administrador puede activar una promoción.',
          DETAIL = 'promo_activation_requires_admin';
      END IF;
      -- An edited draft goes back to the admins. Marketing never writes the approval or the counters.
      NEW.pending_approval := true;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.created_by := OLD.created_by;
      NEW.current_uses := OLD.current_uses;
    ELSIF OLD.is_active OR OLD.current_uses > 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Solo se puede borrar una promoción pausada que nadie usó.',
        DETAIL = 'promo_delete_blocked';
    END IF;
  END IF;
  -- Service role, cron and SQL without a JWT: unchanged.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
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
-- with the same name is kept, and step 6 checks that it uses is_marketing().
DO $policies$
DECLARE
  c_m constant text := '(SELECT public.is_marketing())';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- Reading, for the metrics pages, the campaign segments and the referral list.
      ('rides',              'rides_select_marketing',           'SELECT', c_m,  NULL::text),
      ('users',              'users_select_marketing',           'SELECT', c_m,  NULL),
      ('driver_profiles',    'driver_profiles_select_marketing', 'SELECT', c_m,  NULL),
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

-- 4. Metrics RPCs ---------------------------------------------------------------------------
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
      RAISE EXCEPTION '00641: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    v_target := CASE WHEN position('IF NOT public.is_admin() THEN' IN v_src) > 0
                     THEN 'IF NOT public.is_admin() THEN' ELSE 'IF NOT is_admin() THEN' END;
    IF (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target) <> 1 THEN
      RAISE EXCEPTION '00641: the admin gate is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), v_target, c_gate);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00641: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 5. Live functions that list roles ---------------------------------------------------------
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
      RAISE EXCEPTION '00641: % has a body this file does not know (md5 %); patch it from the live body', r.fn, v_md5;
    END IF;
    IF (length(v_src) - length(replace(v_src, r.target, ''))) / length(r.target) <> 1 THEN
      RAISE EXCEPTION '00641: the role list is not in % exactly once', r.fn;
    END IF;
    EXECUTE replace(pg_get_functiondef(r.fn::regprocedure), r.target, r.repl);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00641: % patched to an unexpected body (md5 %)', r.fn, v_md5;
    END IF;
  END LOOP;
END
$patch$;

-- 6. What this file promises ----------------------------------------------------------------
DO $check$
DECLARE
  v_tbl text;
  v_name text;
  v_def text;
BEGIN
  -- is_marketing(): invoker, callable by the API roles (policies call it), false without a JWT.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_marketing()'::regprocedure) THEN
    RAISE EXCEPTION '00641: is_marketing() must not be SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('anon', 'public.is_marketing()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_marketing()', 'EXECUTE') THEN
    RAISE EXCEPTION '00641: anon and authenticated must be able to call is_marketing()';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE anon;
  IF public.is_marketing() THEN
    RAISE EXCEPTION '00641: is_marketing() is true without a JWT';
  END IF;
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.promotions'::regclass
                   AND tgname = 'trg_promotions_marketing_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '00641: trg_promotions_marketing_guard is missing or disabled';
  END IF;

  FOR v_tbl, v_name IN
    SELECT * FROM (VALUES
      ('rides', 'rides_select_marketing'), ('users', 'users_select_marketing'),
      ('driver_profiles', 'driver_profiles_select_marketing'), ('referrals', 'referrals_select_marketing'),
      ('promotions', 'promotions_select_marketing'), ('promotions', 'promotions_insert_marketing'),
      ('promotions', 'promotions_update_marketing'), ('promotions', 'promotions_delete_marketing'),
      ('campaigns', 'campaigns_select_marketing'), ('campaigns', 'campaigns_insert_marketing'),
      ('home_announcements', 'home_announcements_all_marketing'), ('blog_posts', 'blog_posts_all_marketing'),
      ('acquisition_codes', 'acquisition_codes_all_marketing')
    ) AS v(t, n)
  LOOP
    SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') INTO v_def
    FROM pg_policies WHERE schemaname = 'public' AND tablename = v_tbl AND policyname = v_name;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '00641: policy % on % is missing', v_name, v_tbl;
    END IF;
    IF position('is_marketing()' IN v_def) = 0 THEN
      RAISE EXCEPTION '00641: policy % on % does not use is_marketing()', v_name, v_tbl;
    END IF;
  END LOOP;

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
      ('public.enforce_ride_transition()', 'f806997fab31c18e7b369e69f5321c30'),
      ('public.ensure_driver_role_and_tricicoin_on_approval()', '1940d4379a446c8afdf0d47434945c07'),
      ('public.apply_user_rating(uuid)', '96be8c154990651738312ef44861242f')
    ) AS v(fn, md5)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_name::regprocedure) <> v_def THEN
      RAISE EXCEPTION '00641: % does not have the patched body', v_name;
    END IF;
  END LOOP;
END
$check$;

RESET lock_timeout;
