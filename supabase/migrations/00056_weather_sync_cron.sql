-- 00056: Schedule weather sync cron job
-- Runs every 15 minutes to check Havana weather and adjust surge pricing

SELECT cron.schedule(
  'sync-weather',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-weather',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
