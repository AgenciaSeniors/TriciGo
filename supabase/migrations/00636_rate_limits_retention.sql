-- ============================================================
-- Migration 00636: retention for public.rate_limits
--
-- rate_limits (00105) has no retention. On 2026-10-07 it held 90,248 rows
-- (19 MB) going back to 2026-06-07, 72,738 of them one-hit buckets of the
-- NETOPIA keepwarm cron (create-netopia-pi:44.234.196.74, every 2 min). It is
-- the fourth history table without retention, after audit_log and
-- cron.job_run_details (00576) and admin_actions (00606).
--
-- cleanup_rate_limits() existed since 00105 but no cron job ever called it, and
-- it must not be scheduled as it was: it deleted every row older than 2 hours.
-- check_rate_limit uses fixed windows of up to 24 h (send-sms-otp foreign daily
-- cap, broadcast-emergency per day, new-device-email, and since 00635 send_gift
-- and trusted-contact e-mail), so it would have deleted open windows and reset
-- those caps.
--
-- New rules:
--   * Keep 30 days. Rows are forensic evidence (count - limit = calls rejected
--     with 429, per function and IP), and 30 days must stay far above the
--     longest window check_rate_limit is called with (24 h today).
--   * Delete in batches, oldest first (default 20,000 per call; the backlog of
--     ~59k expired rows drains in 3 hourly runs). This migration deletes
--     nothing itself: the job does it.
--   * No EXCEPTION handler: an error fails the job run, which is what
--     check_cron_sql_failures (00596) reads.
--
-- The return type changes (void -> integer), so the old zero-argument function
-- is dropped first. It had no callers in the repo or in prod.
-- No new table: no GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- ============================================================

DROP FUNCTION IF EXISTS public.cleanup_rate_limits();

CREATE OR REPLACE FUNCTION public.cleanup_rate_limits(p_batch integer DEFAULT 20000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- Must stay well above the longest window passed to check_rate_limit (24 h).
  c_keep    CONSTANT interval := interval '30 days';
  v_batch   integer := COALESCE(p_batch, 20000);
  v_deleted integer;
BEGIN
  IF v_batch < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('cleanup_rate_limits: batch must be at least 1, got %s', v_batch);
  END IF;

  DELETE FROM rate_limits WHERE ctid IN (
    SELECT r.ctid FROM rate_limits r
    WHERE r.window_start < now() - c_keep
    ORDER BY r.window_start
    LIMIT v_batch);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$function$;

COMMENT ON FUNCTION public.cleanup_rate_limits(integer) IS
  '00636: deletes rate_limits rows older than 30 days, oldest first, at most p_batch per call. '
  'Called hourly by the cleanup-rate-limits cron job. Errors are raised on purpose (check_cron_sql_failures).';

REVOKE ALL ON FUNCTION public.cleanup_rate_limits(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_rate_limits(integer) TO service_role;

-- Hourly at minute 13: no other job runs at that minute except the every-minute
-- and every-2-minute ones.
SELECT cron.unschedule('cleanup-rate-limits') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-rate-limits');
SELECT cron.schedule('cleanup-rate-limits', '13 * * * *', 'SELECT public.cleanup_rate_limits();');

-- Self-checks: the migration asserts its own result instead of trusting it.
DO $check$
DECLARE
  v_fn     oid := to_regprocedure('public.cleanup_rate_limits(integer)');
  v_jobs   text;
  v_before bigint;
  v_after  bigint;
  v_n      integer;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '00636: public.cleanup_rate_limits(integer) is missing';
  END IF;
  IF to_regprocedure('public.cleanup_rate_limits()') IS NOT NULL THEN
    RAISE EXCEPTION '00636: the old zero-argument cleanup_rate_limits() is still there';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00636: cleanup_rate_limits is executable by a client role';
  END IF;

  SELECT string_agg(schedule || '|' || command, ',') INTO v_jobs
  FROM cron.job WHERE jobname = 'cleanup-rate-limits';
  IF v_jobs IS DISTINCT FROM '13 * * * *|SELECT public.cleanup_rate_limits();' THEN
    RAISE EXCEPTION '00636: cron job cleanup-rate-limits is %, expected hourly at minute 13', COALESCE(v_jobs, 'missing');
  END IF;

  -- Probe: a row older than any real one must be the first and only row a batch of
  -- 1 deletes. Everything here is rolled back by the final RAISE. It counts only
  -- rows older than 2 days: check_rate_limit keeps inserting rows while this runs,
  -- but never with a window_start older than its longest window (24 h).
  BEGIN
    SELECT count(*) INTO v_before FROM public.rate_limits WHERE window_start < now() - interval '2 days';
    INSERT INTO public.rate_limits (key, window_start, count) VALUES ('zz_00636_probe', '1970-01-02 00:00:00+00', 1);
    v_n := public.cleanup_rate_limits(1);
    SELECT count(*) INTO v_after FROM public.rate_limits WHERE window_start < now() - interval '2 days';
    IF v_n <> 1 OR v_after <> v_before
       OR EXISTS (SELECT 1 FROM public.rate_limits WHERE key = 'zz_00636_probe') THEN
      RAISE EXCEPTION '00636: cleanup probe failed (returned %, rows before %, after %)', v_n, v_before, v_after;
    END IF;
    RAISE EXCEPTION 'zz_00636_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'zz_00636_probe_rollback' THEN
      RAISE;
    END IF;
  END;
END
$check$;
