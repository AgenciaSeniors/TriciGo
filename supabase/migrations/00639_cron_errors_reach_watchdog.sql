-- ============================================================
-- Migration 00639: let cron job errors reach check_cron_sql_failures
--
-- check_cron_sql_failures (00596/00597) counts a run as failed only when
-- cron.job_run_details.return_message starts with "ERROR:". Eleven SQL cron
-- functions wrapped their whole body in
--   EXCEPTION WHEN OTHERS THEN RAISE WARNING ...; RETURN '{"ok": false}'
-- so any error made the run "succeeded". The handler also rolled back
-- everything the function had done (its state write in platform_config and
-- the e-mails it had queued), so a broken watchdog stopped writing its state,
-- sent nothing and still looked healthy:
--   watchdogs  check_cron_http_failures, check_database_health,
--              check_exchange_rate_freshness, check_poi_sync_freshness,
--              check_sms_delivery_health, check_sms_delivery_rate,
--              check_stuck_active_rides (outer handler only), send_db_health_digest
--   pruning    prune_audit_log, prune_cron_job_run_details, prune_driver_heartbeat_log
-- Two helpers they call had the same handler, and their caller discarded the
-- result:
--   sample_database_health    the worst case: evaluate_database_health does not
--                             check the age of the latest sample, so with
--                             sampling broken check_database_health kept
--                             reporting "ok" on the last good sample and kept
--                             refreshing db_health_at.
--   notify_dead_driver_alert  called inside release_rides_from_dead_drivers.
--
-- Measured in prod on 2026-10-08: none of them is failing (all 17 SQL cron jobs
-- with a handler succeeded in every run of the last 14 days, no WARNING from
-- them in the 24 h of postgres logs, every watchdog state written within the
-- hour, every pruned table within its retention). Nothing to clean up.
--
-- What changes:
--   * The handlers above are removed, in place on the live bodies
--     (pg_get_functiondef + replace). Each body must have the md5 read from prod
--     on 2026-10-08, or already be patched; any other body aborts the migration.
--   * notify_dead_driver_alert moves to its own job, notify-dead-driver-alert,
--     one minute after release-dead-driver-rides. Without its handler, a failed
--     e-mail inside release_rides_from_dead_drivers would roll back the
--     releases. Its pending alerts stay in stuck_ride_alerts (emailed_at IS
--     NULL), so the separate job picks them up.
--
-- Kept on purpose:
--   * per-row handlers (one bad row must not stop the rest):
--     activate_scheduled_rides, create_rides_for_recurring, the per-ride e-mail
--     in check_stuck_active_rides, the per-group push in
--     notify_offline_drivers_for_searching_rides.
--   * handlers around a push or e-mail that runs after the job's real work:
--     auto_offline_stale_drivers, release_rides_from_dead_drivers (rider push),
--     retry_dispatch_expired_rides (reactivation push),
--     notify_support_waiting_rides (digest), _support_alert, cron_http_post
--     (bookkeeping). Their HTTP failures already reach check_cron_http_failures.
--
-- Only pg_cron calls these functions: no SQL function calls them besides each
-- other, only service_role can execute them, and nothing in the apps or the
-- Edge Functions references them. A run is its own transaction, so an error
-- fails that run and nothing else. check_cron_sql_failures mails after 3
-- consecutive failed runs seen in 2 hourly reviews: ~1-2 h for the */5 and
-- */15 jobs, ~3-4 h for the hourly ones, ~3 days for the daily ones.
--
-- No new table: no GRANT rules apply (see CLAUDE.md, "Tablas nuevas en public").
-- The patch texts are ASCII and written with E'' escapes, so pasting this file
-- with CRLF line endings does not change what is matched.
-- ============================================================

DO $patch$
DECLARE
  r      record;
  v_oid  oid;
  v_md5  text;
  v_src  text;
  v_def  text;
  v_bad  text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('public.check_cron_http_failures()',
     '6b98f714dda196b1cbec8bb8ca5877b5', '3bcacc073b307c74b8ef7e137865de32',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''check_cron_http_failures failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_database_health()',
     '5977319218fc36d3c304a010afd714aa', '9b430de3b750510e0079ea5b122f110f',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''check_database_health failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_exchange_rate_freshness()',
     '4516f6eaf875c82c19f55f59139f297a', '658b8be4592ab74821ee0df845579437',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''check_exchange_rate_freshness failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_poi_sync_freshness()',
     '5eadc628202089e46b81c1c27335adec', 'c9434e9e1c75a6504f84de2074369a88',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''check_poi_sync_freshness failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_sms_delivery_health()',
     '4772591574069fa40d0207370ca5db4f', 'bf6f70fa0eccf6204f901585a6231ff3',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''check_sms_delivery_health failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_sms_delivery_rate()',
     'f522e403e3c9c1f8a139b5958390538a', 'b4a1e7798ef2ad6b78c2722591b2137a',
     E'EXCEPTION WHEN OTHERS THEN\n  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.\n  RAISE WARNING ''check_sms_delivery_rate failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.check_stuck_active_rides()',
     '863c3bf93fa8f655c53bf01ef507a180', '8478bba2e479523f4d52855adf7454ca',
     E'EXCEPTION WHEN OTHERS THEN\n  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.\n  RAISE WARNING ''check_stuck_active_rides failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.send_db_health_digest()',
     '1aea42c6793f6b671595bffaf0270fa1', '56da1c243a370de9cdfd077870069ada',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''send_db_health_digest failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.sample_database_health()',
     'ff5051ef8e16b0c5cda03e65208dec72', 'a783d40d937aa44aba84f1ba31e819fe',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''sample_database_health failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.prune_audit_log()',
     'b0dc29f0fe42cb2945a325189d378e47', '31047360d4acebcd77df5ac5f8466829',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''prune_audit_log failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.prune_cron_job_run_details()',
     '0f071ed728ee6d023d42c7233f9add3b', 'd36caf9ff0b05e0dda2dc39bd7d49740',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''prune_cron_job_run_details failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.prune_driver_heartbeat_log()',
     '8265af3f0aad993b95b1a0d342087438', '3d773de2f38ded589e5789be92577d5b',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''prune_driver_heartbeat_log failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.notify_dead_driver_alert()',
     '53f5bdf95aa8c09ee6e856c9ca5fcf90', 'aa6a768cbd67d7b2cd7bfa4e135875f3',
     E'EXCEPTION WHEN OTHERS THEN\n  RAISE WARNING ''[notify_dead_driver_alert] failed: % %'', SQLSTATE, SQLERRM;\n  RETURN jsonb_build_object(''ok'', false, ''error'', SQLERRM);\n',
     E''),
    ('public.release_rides_from_dead_drivers()',
     '0e18ee0004fdc8f6735fc93d17520eab', '368d21afc6920a4afcc51475ae460200',
     E'  PERFORM public.notify_dead_driver_alert();\n',
     E'  -- 00639: the e-mail runs in its own cron job (notify-dead-driver-alert), so a\n  -- failure there fails that job and never rolls back the releases above.\n')
    ) AS t(fn, md5_live, md5_new, old_text, new_text)
  LOOP
    v_oid := to_regprocedure(r.fn);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION '00639: % is missing', r.fn;
    END IF;

    SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = v_oid;
    CONTINUE WHEN v_md5 = r.md5_new;   -- already patched (second run)
    IF v_md5 <> r.md5_live THEN
      RAISE EXCEPTION '00639: % has a body this migration does not know (md5 %), refusing to patch it', r.fn, v_md5;
    END IF;

    v_def := pg_get_functiondef(v_oid);
    IF (length(v_src) - length(replace(v_src, r.old_text, ''))) / length(r.old_text) <> 1
       OR (length(v_def) - length(replace(v_def, r.old_text, ''))) / length(r.old_text) <> 1 THEN
      RAISE EXCEPTION '00639: the text to patch in % does not appear exactly once', r.fn;
    END IF;

    EXECUTE replace(v_def, r.old_text, r.new_text);

    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
    IF v_md5 <> r.md5_new THEN
      RAISE EXCEPTION '00639: % was patched to md5 %, expected %', r.fn, v_md5, r.md5_new;
    END IF;
  END LOOP;
END
$patch$;

-- The dead-driver e-mail in its own job, one minute after release-dead-driver-rides
-- (*/5): minutes 1, 6, 11, ... 56.
SELECT cron.unschedule('notify-dead-driver-alert') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-dead-driver-alert');
SELECT cron.schedule('notify-dead-driver-alert', '1-59/5 * * * *', 'SELECT public.notify_dead_driver_alert();');

COMMENT ON FUNCTION public.notify_dead_driver_alert() IS
  '00555 + 00639: e-mails the dead_driver_app alerts that release_rides_from_dead_drivers (00542) records. '
  'It looks for the pending ones (emailed_at IS NULL), so it catches up after a failure. Without a recipient '
  'configured it does not stamp emailed_at, so the next run retries. Since 00639 it runs in its own cron job '
  '(notify-dead-driver-alert, 1-59/5) with no EXCEPTION handler: a failure fails that job, which '
  'check_cron_sql_failures reports, and never rolls back the releases.';

-- Self-checks: the migration asserts its own result instead of trusting it.
DO $check$
DECLARE
  c_no_handler CONSTANT text[] := ARRAY[
    'check_cron_http_failures', 'check_database_health', 'check_exchange_rate_freshness',
    'check_poi_sync_freshness', 'check_sms_delivery_health', 'check_sms_delivery_rate',
    'send_db_health_digest', 'sample_database_health', 'prune_audit_log',
    'prune_cron_job_run_details', 'prune_driver_heartbeat_log', 'notify_dead_driver_alert'];
  v_bad    text;
  v_jobs   text;
  v_probe1 text;
  v_probe2 text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (c_no_handler)
    AND p.prosrc ~* 'exception\s+when';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00639: still an EXCEPTION handler in %', v_bad;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY (c_no_handler)) <> 12 THEN
    RAISE EXCEPTION '00639: expected 12 functions without a handler';
  END IF;

  -- check_stuck_active_rides keeps only its per-ride e-mail handler.
  IF (SELECT count(*) FROM regexp_matches(
        (SELECT prosrc FROM pg_proc WHERE oid = 'public.check_stuck_active_rides()'::regprocedure),
        'exception\s+when', 'gi')) <> 1
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.check_stuck_active_rides()'::regprocedure)
        NOT LIKE '%stuck-ride email failed for ride%' THEN
    RAISE EXCEPTION '00639: check_stuck_active_rides must keep exactly its per-ride e-mail handler';
  END IF;

  -- Nothing but the new job calls notify_dead_driver_alert; the release keeps its rider-push handler.
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'notify_dead_driver_alert'
    AND p.prosrc ~ 'notify_dead_driver_alert\s*\(';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00639: notify_dead_driver_alert is still called from %', v_bad;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(
        (SELECT prosrc FROM pg_proc WHERE oid = 'public.release_rides_from_dead_drivers()'::regprocedure),
        'exception\s+when', 'gi')) <> 1 THEN
    RAISE EXCEPTION '00639: release_rides_from_dead_drivers must keep exactly its rider-push handler';
  END IF;

  SELECT string_agg(schedule || '|' || command, ',') INTO v_jobs
  FROM cron.job WHERE jobname = 'notify-dead-driver-alert';
  IF v_jobs IS DISTINCT FROM '1-59/5 * * * *|SELECT public.notify_dead_driver_alert();' THEN
    RAISE EXCEPTION '00639: cron job notify-dead-driver-alert is %', COALESCE(v_jobs, 'missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-dead-driver-rides'
                 AND command ILIKE '%release_rides_from_dead_drivers()%') THEN
    RAISE EXCEPTION '00639: cron job release-dead-driver-rides is missing';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = ANY (c_no_handler || ARRAY['check_stuck_active_rides', 'release_rides_from_dead_drivers'])
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00639: executable by a client role: %', v_bad;
  END IF;

  -- Probes: an error inside the functions now reaches the caller. A retention of
  -- 2,000,000,000 days makes "now() - make_interval(days => ...)" overflow
  -- (22008). Everything here is rolled back by the final RAISE.
  BEGIN
    INSERT INTO public.platform_config (key, value) VALUES
      ('driver_heartbeat_retention_days', to_jsonb(2000000000)),
      ('db_health_sample_retention_days', to_jsonb(2000000000))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

    BEGIN
      PERFORM public.prune_driver_heartbeat_log();
      v_probe1 := 'returned';
    EXCEPTION WHEN datetime_field_overflow THEN
      v_probe1 := 'raised';
    END;

    -- Through the nested call: sample_database_health fails, check_database_health must fail too.
    BEGIN
      PERFORM public.check_database_health();
      v_probe2 := 'returned';
    EXCEPTION WHEN datetime_field_overflow THEN
      v_probe2 := 'raised';
    END;

    RAISE EXCEPTION 'zz_00639_probe_rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'zz_00639_probe_rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_probe1 IS DISTINCT FROM 'raised' OR v_probe2 IS DISTINCT FROM 'raised' THEN
    RAISE EXCEPTION '00639: probe failed (prune_driver_heartbeat_log %, check_database_health %)', v_probe1, v_probe2;
  END IF;
END
$check$;
