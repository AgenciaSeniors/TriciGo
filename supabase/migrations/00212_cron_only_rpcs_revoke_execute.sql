-- ============================================================
-- BUG-183: five cron-only RPCs are EXECUTE-granted to authenticated.
-- They were never meant to be invoked by app users — they exist
-- purely as targets for pg_cron schedules. Granting EXECUTE to
-- authenticated lets any logged-in user spam them through PostgREST:
--
--   - auto_cancel_stale_searching_rides()  → mass-cancel rides
--   - create_rides_for_recurring()         → force-spawn recurring
--   - retry_dispatch_expired_rides()       → re-dispatch all expired
--   - activate_scheduled_rides()           → activate scheduled early
--   - calculate_surge_predictions()        → kick off expensive job
--
-- pg_cron runs jobs as `supabase_admin` (or postgres) which has
-- table-level access independent of EXECUTE grants on functions.
-- So removing the grant from authenticated/anon doesn't break the
-- cron schedules — it just stops PostgREST exposure.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.auto_cancel_stale_searching_rides() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_rides_for_recurring() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_dispatch_expired_rides() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activate_scheduled_rides() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_surge_predictions() FROM PUBLIC, anon, authenticated;

-- Verify post-state
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT unnest(ARRAY[
    'auto_cancel_stale_searching_rides()',
    'create_rides_for_recurring()',
    'retry_dispatch_expired_rides()',
    'activate_scheduled_rides()',
    'calculate_surge_predictions()'
  ]) AS sig
  LOOP
    IF has_function_privilege('authenticated', ('public.'||r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.'||r.sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'BUG-183 NOT FIXED: % still callable by anon/authenticated', r.sig;
    END IF;
  END LOOP;
END $$;
