-- ============================================================
-- 00594: cleanup_auth_revocations() stopped deleting anything
--
-- The daily cron (jobid 28, 03:00 UTC, `SELECT public.cleanup_auth_revocations();`)
-- failed on all 14 runs cron.job_run_details still keeps (2026-09-12 to
-- 2026-09-25) with "query returned more than one row". The bug is in the body
-- since 00297: `DELETE ... RETURNING 1 INTO v_deleted`. In PL/pgSQL an
-- INSERT/UPDATE/DELETE ... RETURNING ... INTO raises TOO_MANY_ROWS when the
-- statement touches more than one row, STRICT or not. So the DELETE rolls back,
-- the stale rows stay, and the next night there are more of them: once two rows
-- are older than 24 h the job can never succeed again. On 2026-09-25 prod had
-- 62 rows, all of them stale. The oldest was revoked 2026-07-09 11:26 UTC and
-- any successful run from 2026-07-11 03:00 on would have deleted it, so the
-- job has not succeeded once since then.
--
-- No user impact. revoke_user_tokens() writes a row on sign-out, and the only
-- reader, is_session_revoked(), has no caller in any function or policy. The
-- cost was a job failing every night and a table that only grows.
--
-- Fix: drop the RETURNING ... INTO. The GET DIAGNOSTICS ... ROW_COUNT that was
-- already there reports how many rows went away. Everything else is the live
-- definition read with pg_get_functiondef on 2026-09-25 (md5(prosrc)
-- 8fa2316a52152feef7d71eb2b51447db, identical to 00297): same signature,
-- SECURITY DEFINER, search_path and 24 h cutoff. CREATE OR REPLACE keeps the
-- live ACL (postgres and service_role only); the REVOKE/GRANT restate it for a
-- fresh database. The backlog is left to the next 03:00 run.
-- Rehearsal: supabase/tests/00594/run.sh.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_auth_revocations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM auth_revocations
  WHERE revoked_at < now() - interval '24 hours';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_auth_revocations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_auth_revocations() TO service_role;

-- Assert the fix instead of trusting the CREATE: a plpgsql body is not checked
-- until it runs, and the bug only shows with two or more stale rows. Seed two,
-- run the cleanup, then undo everything the block did (the two seeds and any
-- real stale rows the call removed). If the call still raises TOO_MANY_ROWS,
-- that error is not the one caught here, so it aborts the migration.
DO $$
DECLARE
  v_deleted integer;
BEGIN
  BEGIN
    INSERT INTO public.auth_revocations (user_id, revoked_at, reason)
    VALUES (gen_random_uuid(), now() - interval '2 days', '00594 self-test'),
           (gen_random_uuid(), now() - interval '2 days', '00594 self-test');
    v_deleted := public.cleanup_auth_revocations();
    RAISE EXCEPTION '00594 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00594 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_deleted IS NULL OR v_deleted < 2 THEN
    RAISE EXCEPTION '00594: cleanup_auth_revocations() removed % rows, expected at least 2', v_deleted;
  END IF;
  RAISE NOTICE '00594: verified, the cleanup removes % stale rows in one run', v_deleted;
END $$;
