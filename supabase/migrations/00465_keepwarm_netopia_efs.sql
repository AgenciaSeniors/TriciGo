-- ============================================================
-- 00465_keepwarm_netopia_efs.sql
--
-- Keep the NETOPIA recharge Edge Functions warm so the in-app checkout opens
-- fast. They're invoked only when a user recharges (infrequent) → they
-- cold-start ~3-4s each, which is the dominant "demora en entrar" delay
-- (measured 2026-06-27: create-netopia-payment-intent ~4.0s, mint ~1.5s;
-- the VPS tunnel itself is <1s). A 2-minute ping keeps a warm isolate.
--
-- SAFETY: each ping POSTs an EMPTY body with the service_role. The EF boots,
-- fails its own auth (service_role is not a user) / body validation, and
-- returns early WITHOUT creating a payment_intent → warm isolate, zero side
-- effect. Verified in prod: 0 intents created by the keep-warm pings.
--
-- cron.schedule() upserts by job name → this migration is idempotent.
-- Already applied to prod 2026-06-27 (jobs 'keepwarm-netopia-create-intent'
-- + 'keepwarm-netopia-mint'); this records it in git.
-- Reverse with: SELECT cron.unschedule('keepwarm-netopia-create-intent');
--               SELECT cron.unschedule('keepwarm-netopia-mint');
-- ============================================================

SELECT cron.schedule(
  'keepwarm-netopia-create-intent', '*/2 * * * *',
  $$SELECT net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/create-netopia-payment-intent',
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||get_service_role_key(),
        'apikey', get_service_role_key(), 'x-keepwarm','1'),
      body := '{}'::jsonb);$$
);

SELECT cron.schedule(
  'keepwarm-netopia-mint', '*/2 * * * *',
  $$SELECT net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/mint-netopia-proxy-credential',
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||get_service_role_key(),
        'apikey', get_service_role_key(), 'x-keepwarm','1'),
      body := '{}'::jsonb);$$
);
