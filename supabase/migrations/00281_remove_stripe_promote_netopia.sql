-- ============================================================
-- Migration 00281: Remove Stripe as the active provider, make
-- NETOPIA the only enabled processor for new recharges.
--
-- Scope: this migration handles the CONFIG cutover. The code
-- cutover (deleting Stripe edge functions, removing Stripe
-- types/wrappers, switching the wallet UI off Stripe Elements)
-- ships in the same PR.
--
-- What this does:
--   1. netopia_enabled = true   — NETOPIA is now the live provider
--   2. stripe_enabled  = false  — Stripe stays off
--   3. active_payment_provider = 'netopia' — the registry pointer
--      every new caller of paymentService respects
--   4. DELETE every stripe_* row from platform_config — secrets
--      and config we never want re-read by edge functions; the
--      stripe_webhook_secret stays around in Supabase Edge Function
--      secrets store and must be removed there separately by the
--      operator (Project Settings → Edge Functions → Secrets).
--
-- NOT in this migration (kept for backwards compat with historical
-- data, deferred to a later cleanup PR):
--   - RPC `process_stripe_recharge` (still in use — NETOPIA's
--     webhook calls it; PAYMENT_PROVIDER_CONTRACT.md §3 plans a
--     rename to process_recharge_payment).
--   - Stripe-specific columns on payment_intents
--     (stripe_payment_intent_id, card_brand, card_last4 — historical
--     rows keep their values; NETOPIA reuses
--     stripe_payment_intent_id as the generic provider intent id).
--
-- Reversibility: re-creating the rows is a single INSERT; the secret
-- keys themselves need to come from the operator's stored copy. This
-- is a documented one-way cutover, decided 2026-05-20.
-- ============================================================

-- 1. Update the registry and provider flags.
INSERT INTO platform_config (key, value) VALUES
  ('active_payment_provider', '"netopia"'),
  ('netopia_enabled', 'true'),
  ('stripe_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 2. Drop every other stripe_* config row. These were Stripe-specific
--    credentials, limits, fees. The min/max/fee for NETOPIA already
--    live under netopia_* keys (migration 00280).
DELETE FROM platform_config
WHERE key LIKE 'stripe_%'
  AND key NOT IN ('stripe_enabled');
