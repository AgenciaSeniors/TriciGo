-- ============================================================
-- Migration 00648: one bad ride no longer stops the re-dispatch of the others
--
-- retry_dispatch_expired_rides (cron retry-dispatch-expired-rides, every minute)
-- called dispatch_ride for every eligible searching ride in one transaction,
-- with no guard per ride. If dispatch_ride raised for one ride, the whole run
-- rolled back: no ride got its offers re-sent that minute, and the next minute
-- the same ride failed again. Because cleanup_orphan_searching_rides only
-- cancels a ride whose rider stopped looking, a rider with the app open could
-- keep that ride "searching", and with it block every other re-dispatch.
--
-- dispatch_ride has no RAISE of its own (measured in prod on 2026-10-08): the
-- normal cases (ride no longer searching, no driver found) return jsonb. Any
-- exception from it is a real failure. It never happened in the 14 days of
-- cron history (20,160 runs, all succeeded).
--
-- What changes (patched in place on the live body; it must have the md5 read
-- from prod, or already be patched):
--   * Each ride runs in its own subtransaction. A ride that fails is skipped:
--     its partial work rolls back, a WARNING is logged, and a row goes to
--     rpc_attempt_log (rpc_name 'retry_dispatch_expired_rides', outcome
--     'dispatch_failed', target_id = ride id, metadata = sqlstate and error).
--     The ride also keeps reaching support through notify_support_waiting_rides
--     (00628), which alerts on any ride searching for more than 60 s.
--   * If no ride could be re-dispatched and at least one failed, the run fails
--     with the count and the last error (with its ride id), so
--     check_cron_sql_failures (00596) reports it. A run with no eligible rides
--     still succeeds and returns 0. A failed run rolls back everything it did:
--     the rpc_attempt_log rows (the error text is then the record) and the
--     reactivation push of notify_offline_drivers_for_searching_rides, which
--     goes out on the next run that succeeds. Before this migration the run rolled back
--     in those minutes too, and in every minute with a bad ride.
--   * A statement timeout (query_canceled) is not caught by WHEN OTHERS, so it
--     still fails the whole run, as before.
--
-- To see the skipped rides:
--   SELECT target_id, metadata, created_at FROM rpc_attempt_log
--   WHERE rpc_name = 'retry_dispatch_expired_rides' ORDER BY created_at DESC LIMIT 20;
--
-- Numbering: this was applied to prod as 00647_retry_dispatch_per_ride on 2026-10-08,
-- two minutes after #1127 applied its own 00647, so the file became 00648. The
-- comments inside the patched body still say 00647: that is the body prod runs,
-- and the md5 checks below are of that body.
--
-- No new table: no GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- The patch texts are ASCII and written with E'' escapes, so pasting this file
-- with CRLF line endings does not change what is matched.
-- ============================================================

DO $patch$
DECLARE
  c_fn       CONSTANT text := 'public.retry_dispatch_expired_rides()';
  c_md5_live CONSTANT text := '44da5d968977eadfcec31e0f7dbd959e';
  c_md5_new  CONSTANT text := '1782a21256deceb7288892daae968729';
  c_old      CONSTANT text[] := ARRAY[
    E'  v_processed   int := 0;\n',
    E'    PERFORM dispatch_ride(r.id);\n    v_processed := v_processed + 1;\n  END LOOP;\n',
    E'  RETURN v_processed;\nEND;\n'];
  c_new      CONSTANT text[] := ARRAY[
    E'  v_processed   int := 0;\n  v_failed      int := 0;\n  v_last_error  text;\n',
    E'    -- 00647: one ride per subtransaction, so a ride that makes dispatch_ride\n    -- fail does not stop the re-dispatch of the others.\n    BEGIN\n      PERFORM dispatch_ride(r.id);\n      v_processed := v_processed + 1;\n    EXCEPTION WHEN OTHERS THEN\n      v_failed := v_failed + 1;\n      v_last_error := ''ride '' || r.id || '': '' || SQLSTATE || '' '' || SQLERRM;\n      RAISE WARNING ''[retry_dispatch] not re-dispatched, %'', v_last_error;\n      PERFORM log_rpc_attempt(''retry_dispatch_expired_rides'', NULL, r.id, ''dispatch_failed'',\n        jsonb_build_object(''sqlstate'', SQLSTATE, ''error'', SQLERRM));\n    END;\n  END LOOP;\n',
    E'  -- 00647: if no ride could be re-dispatched, fail the run, so that\n  -- check_cron_sql_failures reports a broken dispatch_ride.\n  IF v_failed > 0 AND v_processed = 0 THEN\n    RAISE EXCEPTION ''retry_dispatch_expired_rides: none of the % rides could be re-dispatched, last error: %'',\n      v_failed, v_last_error;\n  END IF;\n\n  RETURN v_processed;\nEND;\n'];
  v_oid oid;
  v_md5 text;
  v_src text;
  v_def text;
  i     int;
BEGIN
  v_oid := to_regprocedure(c_fn);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '00648: % is missing', c_fn;
  END IF;

  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = v_oid;
  IF v_md5 = c_md5_new THEN
    RETURN;   -- already patched (second run)
  END IF;
  IF v_md5 <> c_md5_live THEN
    RAISE EXCEPTION '00648: % has a body this migration does not know (md5 %), refusing to patch it', c_fn, v_md5;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  FOR i IN 1 .. array_length(c_old, 1) LOOP
    IF (length(v_src) - length(replace(v_src, c_old[i], ''))) / length(c_old[i]) <> 1
       OR (length(v_def) - length(replace(v_def, c_old[i], ''))) / length(c_old[i]) <> 1 THEN
      RAISE EXCEPTION '00648: patch text % does not appear exactly once in %', i, c_fn;
    END IF;
    v_src := replace(v_src, c_old[i], c_new[i]);
    v_def := replace(v_def, c_old[i], c_new[i]);
  END LOOP;

  EXECUTE v_def;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_md5_new THEN
    RAISE EXCEPTION '00648: % was patched to md5 %, expected %', c_fn, v_md5, c_md5_new;
  END IF;
END
$patch$;

-- Self-checks: the migration asserts its own result instead of trusting it.
DO $check$
DECLARE
  v_oid oid := to_regprocedure('public.retry_dispatch_expired_rides()');
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '1782a21256deceb7288892daae968729' THEN
    RAISE EXCEPTION '00648: retry_dispatch_expired_rides has md5 %', md5(v_src);
  END IF;
  -- The per-ride guard and the reactivation-push guard, nothing else.
  IF (SELECT count(*) FROM regexp_matches(v_src, 'exception\s+when', 'gi')) <> 2 THEN
    RAISE EXCEPTION '00648: retry_dispatch_expired_rides must have exactly two EXCEPTION handlers';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '00648: retry_dispatch_expired_rides is executable by a client role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-dispatch-expired-rides'
                 AND command ILIKE '%retry_dispatch_expired_rides()%' AND active) THEN
    RAISE EXCEPTION '00648: cron job retry-dispatch-expired-rides is missing or inactive';
  END IF;
END
$check$;
