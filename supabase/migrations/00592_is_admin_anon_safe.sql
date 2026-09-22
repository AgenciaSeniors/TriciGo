-- ============================================================
-- 00592: is_admin() must be a plain "no" for anonymous requests
--
-- is_admin() is LANGUAGE sql, SECURITY INVOKER, and calls current_user_role(),
-- a SECURITY DEFINER function that `anon` may not EXECUTE (ACL since 00517:
-- {postgres, authenticated, service_role}). So every RLS policy that reaches
-- is_admin() while the request runs as `anon` does not evaluate to false — it
-- aborts with 42501 "permission denied for function current_user_role".
--
-- Two production victims (2026-09-21/22):
--   1. A driver app whose in-memory session was gone (keystore read failed for
--      ~23 min; the server session was intact) ran as `anon`. Its "Conectarme"
--      UPDATE on driver_profiles hit dp_update_own (`user_id = auth.uid() OR
--      is_admin()`), and that raw text was the toast the driver saw.
--   2. The public blog SSR (an anon client by design) got 401 on blog_posts
--      7 times out of 8: blog_posts_admin_all subqueries users, whose
--      users_select_own policy calls is_admin().
--
-- Fix: when there is no authenticated user, answer false without touching
-- current_user_role(). This has to be plpgsql, not a CASE in a SQL function:
-- the EXECUTE privilege on every function in an expression is checked when the
-- expression is initialized, before any branch runs, so `CASE WHEN auth.uid()
-- IS NULL THEN false ELSE current_user_role() ... END` still fails as anon
-- (measured in supabase/tests/00592). plpgsql prepares each statement the
-- first time it is reached, so the guarded RETURN never touches
-- current_user_role() for anon. SECURITY INVOKER is kept on purpose: anon still
-- may not execute current_user_role() (00517), it just never asks. For an
-- authenticated caller the result is the previous one; the live definition was
-- read with pg_get_functiondef on 2026-09-22 (no AAL2 clause — 00220's version
-- is not what runs). Rehearsal: supabase/tests/00592/run.sh.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;

COMMENT ON FUNCTION public.is_admin() IS
  '00592: false without an authenticated user, WITHOUT calling current_user_role() (anon may not execute it). Policies evaluated as anon get a clean "no" instead of 42501.';

-- Assert the result instead of trusting the CREATE: a plpgsql body is not
-- type-checked at CREATE time, and the whole point is the anon path. Run it as
-- the migration role (no JWT) and, where this role may SET ROLE anon (true on
-- Supabase: postgres is a member of anon), as anon too. If the anon call still
-- raises 42501 the exception aborts the migration, so it cannot report success
-- while leaving the bug in place.
DO $$
DECLARE
  v_as_anon boolean;
BEGIN
  IF public.is_admin() THEN
    RAISE EXCEPTION '00592: is_admin() must be false with no JWT';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND pg_has_role(current_user, 'anon', 'MEMBER') THEN
    EXECUTE 'SET LOCAL ROLE anon';
    v_as_anon := public.is_admin();
    EXECUTE 'RESET ROLE';
    IF v_as_anon THEN
      RAISE EXCEPTION '00592: is_admin() must be false as anon';
    END IF;
    RAISE NOTICE '00592: verified as anon: is_admin() = false, no error';
  ELSE
    RAISE NOTICE '00592: cannot SET ROLE anon from %, anon path not verified here', current_user;
  END IF;
END $$;
