-- 00529_driver_push_crons_watchdog_coverage.sql
--
-- Route the two new driver-push senders through cron_http_post so the cron
-- watchdog can see them fail.
--
-- FOUND BY a deep review of cron 10 on 2026-07-31, at the user's insistence
-- ("revisa bien el cron") after I had already called it healthy. The green I
-- reported was real but partial: cron.job_run_details said `succeeded` for
-- every run, and it always will — pg_cron records the SELECT, never the HTTP
-- (the documented blindness that hid the FX outage for 4 days, and 91 green
-- runs of a failing function before it). The actual push delivery lives in
-- net._http_response, and nothing was watching it:
--
--   SELECT jobname FROM cron_http_calls WHERE called_at > now()-interval '3 hours';
--   → auto-admin, keepwarm-*, probe-netopia-proxy-health, sync-exchange-rate,
--     sync-weather ... and NEITHER of the two functions this migration fixes.
--
-- Both were added this week (00524 reactivation push, 00527 offline notice)
-- using raw net.http_post — violating CLAUDE.md's hard rule: "todo cron nuevo
-- que llame a una Edge Function DEBE usar public.cron_http_post". If send-push
-- starts failing (rotated service key, 502, timeout), the UPDATE keeps
-- succeeding, cron stays green, and drivers silently stop being notified and
-- reactivated — the exact failure class the rule exists to prevent.
--
-- (The same review CONFIRMED delivery currently works: net._http_response
-- showed {"sent":1} for the 01:35 and 01:05 notices, and {"No devices
-- found","sent":0} at 01:10 for a driver with no registered push token. This
-- migration adds no behavior — it adds attribution + monitoring.)
--
-- Distinct labels (not the parent cron jobnames) so a watchdog alert says
-- WHICH sender broke: cron 17 fires both the dispatch retries and the
-- reactivation push; "retry-dispatch-expired-rides is failing" would not say
-- what actually failed.
--
-- send-push answers 200 in every normal case (including zero devices), so no
-- cron_http_expectations rows are needed.
--
-- Both patches are in-place from the LIVE body (canonical pattern): they
-- cannot drop features, they are idempotent, and they fail loudly if the
-- expected fragment is missing. Target `PERFORM net.http_post(` verified to
-- occur exactly once in each function. The remaining named args
-- (url/headers/body) bind unchanged to cron_http_post's parameters of the
-- same names; cron_http_post's own bookkeeping INSERT is exception-guarded,
-- and both call sites already sit inside BEGIN/EXCEPTION blocks, so the
-- courtesy-push contract ("never break the parent job") is preserved.

DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.auto_offline_stale_drivers()'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE '00529: auto_offline_stale_drivers absent; skipping';
    RETURN;
  END IF;
  IF position('cron_http_post' IN v_src) > 0 THEN
    RAISE NOTICE '00529: auto_offline_stale_drivers already covered; skipping';
    RETURN;
  END IF;
  IF position('PERFORM net.http_post(' IN v_src) = 0 THEN
    RAISE EXCEPTION '00529: expected fragment not found in auto_offline_stale_drivers — refusing to patch blindly';
  END IF;
  EXECUTE replace(v_src,
    'PERFORM net.http_post(',
    'PERFORM public.cron_http_post(''driver-offline-notice'', ');
  RAISE NOTICE '00529: auto_offline_stale_drivers now under watchdog coverage';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00529: auto_offline_stale_drivers absent; skipping';
END $patch$;

DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE '00529: reactivation function absent; skipping';
    RETURN;
  END IF;
  IF position('cron_http_post' IN v_src) > 0 THEN
    RAISE NOTICE '00529: reactivation function already covered; skipping';
    RETURN;
  END IF;
  IF position('PERFORM net.http_post(' IN v_src) = 0 THEN
    RAISE EXCEPTION '00529: expected fragment not found in reactivation function — refusing to patch blindly';
  END IF;
  EXECUTE replace(v_src,
    'PERFORM net.http_post(',
    'PERFORM public.cron_http_post(''driver-reactivation-push'', ');
  RAISE NOTICE '00529: reactivation push now under watchdog coverage';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00529: reactivation function absent; skipping';
END $patch$;
