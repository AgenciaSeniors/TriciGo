-- ============================================================
-- BUG-199 (P0 EMERGENCY): the service_role JWT was hardcoded in
-- 11 prior migration files which are committed to a PUBLIC GitHub
-- repo. The JWT bypasses RLS and doesn't expire until 2036.
--
-- This migration rebuilds every cron job that calls an Edge Function
-- with a Bearer token so it reads the JWT from vault.decrypted_secrets
-- (key name `service_role_jwt`) instead of hardcoding it. Once this
-- migration is applied AND the user has rotated the JWT and stored
-- the new value in vault, the secret never appears in plaintext SQL.
--
-- PREREQUISITE — read docs/JWT_ROTATION.md before applying:
--   1. Rotate the service_role JWT in Supabase Dashboard.
--   2. Insert the new JWT into vault as `service_role_jwt`.
--   3. Update SUPABASE_SERVICE_ROLE_KEY env var on every Edge Function.
--   4. THEN apply this migration. Otherwise crons will fail.
--
-- The migration is idempotent: re-applying picks up the latest vault
-- value (which is what we want if the JWT is rotated again).
-- ============================================================

-- ── auto-admin (every 5 min) ─────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-admin') THEN
    PERFORM cron.unschedule('auto-admin');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-admin',
  '*/5 * * * *',
  $cmd$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/auto-admin',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_jwt')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

-- ── sync-exchange-rate (hourly) ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-exchange-rate') THEN
    PERFORM cron.unschedule('sync-exchange-rate');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-exchange-rate',
  '0 * * * *',
  $cmd$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/sync-exchange-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_jwt')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

-- ── sync-weather (every 15 min) ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-weather') THEN
    PERFORM cron.unschedule('sync-weather');
  END IF;
END $$;

SELECT cron.schedule(
  'sync-weather',
  '*/15 * * * *',
  $cmd$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/sync-weather',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_jwt')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);

-- ── behavioral-emails-daily ──────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'behavioral-emails-daily') THEN
    PERFORM cron.unschedule('behavioral-emails-daily');
  END IF;
END $$;

SELECT cron.schedule(
  'behavioral-emails-daily',
  '0 8 * * *',
  $cmd$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='supabase_url') || '/functions/v1/behavioral-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='service_role_jwt')
    ),
    body := '{}'::jsonb
  ) AS request_id;
  $cmd$
);
