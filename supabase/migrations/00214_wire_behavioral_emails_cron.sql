-- ============================================================
-- BUG-192: the `behavioral-emails-daily` cron job exists with
-- schedule '0 8 * * *' but the command is a stub `SELECT 1;`.
-- The behavioral-emails Edge Function is fully implemented (welcome
-- emails for new users, win-back emails for inactive users) but
-- never gets invoked. Same pattern as BUG-148 (auto-admin stub),
-- different cron.
--
-- Fix: replace the stub with a pg_net.http_post that calls the
-- EF with service_role JWT. Matches the auto-admin / sync-*
-- cron command shape.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'behavioral-emails-daily') THEN
    PERFORM cron.unschedule('behavioral-emails-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'behavioral-emails-daily',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/behavioral-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ'
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
