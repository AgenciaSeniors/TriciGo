-- ============================================================
-- BUG-199 P0 mitigation step 2/3:
--
-- Even after Supabase's legacy JWT secret revocation, the leaked
-- service_role JWT (committed to public git in 11 prior migrations)
-- still authenticated against Edge Functions because:
--   (a) The EF gateway grandfathers legacy-signed JWTs (Supabase
--       quirk; PostgREST already rejects them properly).
--   (b) Our BUG-201 fix made auto-admin, sync-weather, sync-exchange-
--       rate, and send-sms decode the JWT payload and trust the
--       `role` claim WITHOUT verifying the signature. The leaked
--       JWT has role=service_role in payload, so it passed.
--
-- Curl test (2026-04-25): leaked JWT against /functions/v1/auto-admin
-- returned HTTP 200 + executed.
--
-- Real impact today (with BUG-199 platform-level legacy revocation
-- already in place, 19 days ago):
--   - DB / PostgREST: ✅ already protected. Leaked JWT → 401.
--   - send-email, send-bulk-sms, send-bulk-email,
--     notify-business-movement, send-push: ✅ already protected
--     (apikey-vs-env-var or auth.getUser-style validation).
--   - auto-admin, sync-weather, sync-exchange-rate, send-sms: ❌
--     leaked JWT can still trigger them.
--
-- Fix: Supabase already updated the SUPABASE_SERVICE_ROLE_KEY env
-- var on EFs to the new sb_secret_* format. So apikey === env-var
-- (BUG-160 logic) cleanly rejects the leaked legacy JWT.
--
-- Step A: this migration. Update 4 cron commands to also send
--   apikey: <vault.service_role_key>
--   so when we revert the EF code in step B, crons keep working.
--
-- Step B (next): redeploy the 4 EFs with apikey === env var check
--   (revert BUG-201 to BUG-160 logic).
--
-- Step C (verification): curl leaked JWT against EFs → expect 401.
--
-- Order matters: the cron update is harmless on its own (extra
-- header that EF currently ignores). The EF redeploy then enforces
-- the new requirement.
-- ============================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-admin') THEN
    PERFORM cron.unschedule('auto-admin');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-admin',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/auto-admin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDg0NTYsImV4cCI6MjA4ODU4NDQ1Nn0.FwP9cINvtDCyWpT9G6qYV8aSsrvirajOzT7iFbGKSIQ',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-exchange-rate') THEN
    PERFORM cron.unschedule('sync-exchange-rate');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-exchange-rate',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-exchange-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDg0NTYsImV4cCI6MjA4ODU4NDQ1Nn0.FwP9cINvtDCyWpT9G6qYV8aSsrvirajOzT7iFbGKSIQ',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-weather') THEN
    PERFORM cron.unschedule('sync-weather');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-weather',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-weather',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDg0NTYsImV4cCI6MjA4ODU4NDQ1Nn0.FwP9cINvtDCyWpT9G6qYV8aSsrvirajOzT7iFbGKSIQ',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

DO $$ BEGIN
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
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDg0NTYsImV4cCI6MjA4ODU4NDQ1Nn0.FwP9cINvtDCyWpT9G6qYV8aSsrvirajOzT7iFbGKSIQ',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_key')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
