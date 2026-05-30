-- ============================================================
-- Migration 00354: remove dead TropiPay machinery
--
-- TropiPay was removed from the product (NETOPIA is the live processor;
-- zero tropipay payment_intents exist), but its deployed Edge Functions
-- (create-tropipay-link, process-tropipay-webhook) were never deleted and
-- the supporting DB objects + config were still present. That left a
-- forged-webhook wallet-credit vector:
--   process-tropipay-webhook (verify_jwt=false) skips signature
--   verification when TROPIPAY_WEBHOOK_SECRET is unset, then calls the
--   crediting RPCs — and the TropiPay credentials were still configured,
--   so create-tropipay-link could still mint a reference.
--
-- This migration closes the vector at the DB level (applied to prod):
--   1. Drops the crediting RPCs (no legitimate caller).
--   2. Deletes all tropipay_* platform_config (credentials, limits,
--      webhook secret) so create-tropipay-link returns not_configured.
--
-- The deployed Edge Functions themselves must be deleted separately via
-- the CLI/dashboard (no MCP tool for that):
--   supabase functions delete process-tropipay-webhook --project-ref <ref>
--   supabase functions delete create-tropipay-link    --project-ref <ref>
--
-- Reversible: RPC bodies remain in git history. NETOPIA is unaffected
-- (it uses process_recharge_payment + netopia_* config).
-- ============================================================

-- 1) Drop all TropiPay crediting RPC overloads.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('process_tropipay_payment','process_corporate_tropipay_payment','process_ride_tropipay_payment')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.sig);
  END LOOP;
END $$;

-- 2) Remove TropiPay configuration.
DELETE FROM platform_config WHERE key LIKE 'tropipay%';
