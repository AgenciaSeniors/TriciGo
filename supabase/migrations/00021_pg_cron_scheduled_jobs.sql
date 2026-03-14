-- 00021: Scheduled jobs via pg_cron
-- Sets up recurring cron jobs for:
--   1. Exchange rate sync (every hour) via edge function
--   2. Stale ride cancellation (every 2 minutes) via direct SQL

-- Job 1: Sync exchange rate every hour by invoking the edge function
-- Uses pg_net to make async HTTP POST to the edge function
SELECT cron.schedule(
  'sync-exchange-rate',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-exchange-rate',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Job 2: Cancel stale rides every 2 minutes
-- Calls the existing PL/pgSQL function directly (no HTTP needed)
SELECT cron.schedule(
  'cancel-stale-rides',
  '*/2 * * * *',
  $$ SELECT auto_cancel_stale_searching_rides(); $$
);
