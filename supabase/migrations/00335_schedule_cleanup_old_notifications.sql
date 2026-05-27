-- ============================================================
-- 00335_schedule_cleanup_old_notifications.sql
--
-- Schedules the `cleanup_old_notifications()` function that has
-- existed since migration 00040 but never had a cron job pointing
-- at it. Without a scheduler, the `notifications` table grows
-- forever — every push that goes through send-push appends a row
-- but nothing reaps the old ones.
--
-- Schedule: daily at 03:00 server time (matches the cleanup-otp
-- cadence from 00063). Function deletes rows older than 90 days.
-- Idempotent: unschedule first if the job already exists.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-old-notifications') THEN
    PERFORM cron.unschedule('cleanup-old-notifications');
  END IF;
END $$;

SELECT cron.schedule(
  'cleanup-old-notifications',
  '0 3 * * *',
  $$ SELECT cleanup_old_notifications(); $$
);
