-- ============================================================
-- 00630 — dispatch_ride: no EXECUTE for signed-in users (BUG-177, closed for real)
--
-- WHY
--
-- dispatch_ride(uuid, integer) offers a searching ride to every eligible driver:
-- it inserts ride_offers, re-arms the ones that expired past the cooldown, bumps
-- rides.dispatch_round, and every new or re-armed offer fires a push through
-- trg_notify_driver_new_offer / trg_notify_driver_reoffer.
--
-- 00211 (BUG-177, "re-dispatch any ride") meant to make it internal-only with
--
--   IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
--     RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
--
-- on the theory that current_user = 'postgres' means "called from a SECURITY
-- DEFINER function". But dispatch_ride is SECURITY DEFINER itself, owned by
-- postgres, so inside it current_user is always postgres, whoever called it.
-- The check never fired, and authenticated kept EXECUTE: any signed-in user can
-- POST /rest/v1/rpc/dispatch_ride with the id of any searching ride and force a
-- new round. Measured on 2026-10-07: has_function_privilege('authenticated', ...)
-- is true (anon: false). The 00630 rehearsal reproduces it with the live bodies:
-- a signed-in customer re-arms two expired offers on someone else's ride, creates
-- a third, and each one queues a push.
--
-- Nothing outside the database calls it: no app, web page or Edge Function, now or
-- in the git history of apps/, packages/ and supabase/functions/, and the edge logs
-- of 2026-10-06/07 show 0 calls among 19,492 RPC requests. Every caller is a
-- SECURITY DEFINER function owned by postgres, so it calls dispatch_ride as the
-- owner and needs no client grant:
--   on_ride_insert_dispatch               AFTER INSERT on rides
--   tg_dispatch_on_delivery_details       AFTER INSERT on delivery_details
--   dispatch_searching_rides_for_driver   from trg_dispatch_on_driver_online and
--                                         trg_redispatch_searching_on_ride_freed
--   retry_dispatch_expired_rides          cron retry-dispatch-expired-rides
--   activate_scheduled_rides              cron activate-scheduled-rides
--
-- WHAT
--
-- 1. REVOKE EXECUTE from PUBLIC, anon and authenticated; service_role keeps it.
--    Admins lose the direct call too; the panel never made it.
-- 2. Replace the dead check with a comment that says where access is decided, so
--    the next redefinition does not copy it as if it protected anything. The
--    function is patched in place from its live body: only those three lines
--    change, and owner, grants and every other line stay. The check never raised,
--    so no caller sees a difference. If the live body no longer has it in the
--    expected form, the body is left alone (NOTICE) and the revoke still applies.
-- 3. Assert the end state: no overload of the name is executable by anon or
--    authenticated, and the owner (every internal caller runs as it) and
--    service_role still can.
--
-- Idempotent: REVOKE and GRANT are no-ops when repeated, and the patch only acts
-- while the old check is still there.
-- ============================================================

SET lock_timeout = '5s';

REVOKE EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) TO service_role;

-- The dead check, replaced in place from the live body -----------------------
DO $patch$
DECLARE
  v_old CONSTANT text :=
       E'  IF pg_trigger_depth() = 0 AND current_user <> ''postgres'' AND NOT is_admin() THEN\n'
    || E'    RAISE EXCEPTION ''Forbidden: dispatch_ride is internal-only'';\n'
    || E'  END IF;\n';
  v_new CONSTANT text :=
       E'  -- Who may call this is decided by EXECUTE, not here: only the owner and\n'
    || E'  -- service_role hold it (00630). Triggers, cron jobs and other SECURITY\n'
    || E'  -- DEFINER functions call it as the owner. A current_user test cannot tell\n'
    || E'  -- callers apart: inside SECURITY DEFINER it is always the owner.\n';
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.dispatch_ride(uuid, integer)'::regprocedure);
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF v_def ~* 'current_user\s*<>\s*''postgres''' THEN
    RAISE NOTICE '00630: dispatch_ride still has a current_user check, not in the expected form; body unchanged';
  ELSE
    RAISE NOTICE '00630: dispatch_ride carries no current_user check; body unchanged';
  END IF;
END
$patch$;

COMMENT ON FUNCTION public.dispatch_ride(uuid, integer) IS
  'Offers a searching ride to the eligible drivers: new offers, expired ones re-armed past the cooldown, a push each. Internal: triggers, cron jobs and SECURITY DEFINER functions call it as the owner. No EXECUTE for PUBLIC, anon or authenticated (00630).';

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  r record;
  v_found int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'dispatch_ride'
  LOOP
    v_found := v_found + 1;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00630: anon can still execute %', r.sig;
    END IF;
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00630: authenticated can still execute %', r.sig;
    END IF;
  END LOOP;
  IF v_found = 0 THEN
    RAISE EXCEPTION '00630: public.dispatch_ride not found';
  END IF;
  -- Every trigger, cron job and SECURITY DEFINER caller runs it as the owner.
  IF NOT has_function_privilege(
       (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
        WHERE p.oid = 'public.dispatch_ride(uuid, integer)'::regprocedure),
       'public.dispatch_ride(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '00630: the owner cannot execute public.dispatch_ride(uuid,integer); no trigger or cron job could dispatch';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.dispatch_ride(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '00630: service_role lost EXECUTE on public.dispatch_ride(uuid,integer)';
  END IF;
END
$check$;

RESET lock_timeout;
