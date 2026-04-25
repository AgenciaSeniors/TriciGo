-- ============================================================
-- BUG-148: cron jobs auto-admin and behavioral-emails-daily had
-- their commands set to bare 'SELECT 1;' so the actual Edge Functions
-- never ran in production. Effect:
--   - auto-admin EF (driver auto-approve, redemption auto-approve,
--     fraud resolve, incident close, stale TropiPay) fired zero
--     times since deploy. The bugs I fixed in Test 53
--     (BUG-138/139/140/141) couldn't trigger because the EF was
--     never invoked.
--   - behavioral-emails-daily (presumably welcome / win-back drips)
--     never sent.
--
-- Fix: rewrite both cron commands to follow the working pattern from
-- sync-weather and sync-exchange-rate — net.http_post to the EF URL
-- with the service_role JWT (kept inline as in those existing
-- crons, since cron.job is only readable by superuser).
-- ============================================================

DO $$
DECLARE
  v_service_jwt TEXT;
BEGIN
  -- Reuse the same JWT already inline in sync-weather. We extract
  -- it programmatically so we don't end up with two stale copies if
  -- it gets rotated.
  SELECT (regexp_match(command, 'Bearer ([^"]+)'))[1]
  INTO v_service_jwt
  FROM cron.job
  WHERE jobname = 'sync-weather'
  LIMIT 1;

  IF v_service_jwt IS NULL THEN
    RAISE EXCEPTION 'Could not extract service JWT from sync-weather cron';
  END IF;

  -- auto-admin: fire the EF every 5 min
  PERFORM cron.alter_job(
    job_id   => (SELECT jobid FROM cron.job WHERE jobname='auto-admin'),
    command  => format(
      $cmd$
      SELECT net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/auto-admin',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer %s'
        ),
        body := '{}'::jsonb
      ) AS request_id;
      $cmd$,
      v_service_jwt
    )
  );

  -- behavioral-emails-daily: presumably runs another EF for welcome /
  -- win-back drips. There's no behavioral-emails Edge Function deployed
  -- yet, so we leave this one as a no-op for now and let the product
  -- team fill it in. If/when the EF lands, swap the body the same way
  -- as auto-admin above.
END $$;
