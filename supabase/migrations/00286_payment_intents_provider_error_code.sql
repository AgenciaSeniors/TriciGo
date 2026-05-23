-- ============================================================
-- Migration 00286 — payment_intents.provider_error_code
-- ============================================================
--
-- Bug identified during reconciliation of intent d3fc744f (2026-05-23):
-- NETOPIA sent two IPNs for the same transaction, the first with
-- payment.status=12, payment.code="21", payment.message="Invalid CVV".
-- Our webhook persisted payment.message into error_message but DROPPED
-- payment.code on the floor — making it impossible to:
--   1. Aggregate over failure reasons in analytics ("how many CVV
--      rejects per week?").
--   2. Surface the native bank code in support tickets without
--      parsing webhook_payload JSON.
--   3. Build per-code retry / UX hints (some banks signal "try later"
--      via a specific code).
--
-- This column stores the native error code from the payment provider
-- (NETOPIA payment.code, Stripe decline_code, etc.) for debug,
-- analytics, and support workflows. Nullable because successful
-- payments have no code.
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS with no default. The new
-- webhook code persists `ipn.payment?.code` here; old rows stay NULL.
--
-- The companion EF (process-netopia-webhook) ships with a try/retry
-- that tolerates the column being absent (pre-migration deploy),
-- so the order of (apply migration ↔ deploy EF) doesn't matter.
-- ============================================================

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS provider_error_code TEXT NULL;

COMMENT ON COLUMN payment_intents.provider_error_code IS
  'Native error code from the payment provider (NETOPIA payment.code, Stripe decline_code, etc.). Nullable. Used for debug, support tickets, and analytics over time. Populated by the webhook on failed IPNs; null for successful payments and for failures predating this column (introduced 2026-05-23 after intent d3fc744f).';

-- Verification snippets (run manually after apply):
--
--   -- Confirm column exists:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'payment_intents' AND column_name = 'provider_error_code';
--
--   -- After a failed payment with NETOPIA:
--   SELECT id, status, error_message, provider_error_code, created_at
--   FROM payment_intents
--   WHERE status = 'failed' AND payment_provider = 'netopia'
--   ORDER BY created_at DESC LIMIT 5;
