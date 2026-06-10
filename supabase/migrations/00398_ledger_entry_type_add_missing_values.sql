-- ============================================================================
-- 00398 — ledger_entry_type: add the 4 values live RPCs already insert (A3-01)
-- ============================================================================
-- Audit 2026-06-10, finding A3-01: four SECURITY DEFINER money RPCs insert
-- ledger_transactions.type values that are NOT in the ledger_entry_type enum,
-- so each INSERT fails with `invalid input value for enum ledger_entry_type`
-- and the whole transaction rolls back. None have fired yet (the prod data
-- was wiped 2026-06-07 and these paths hadn't been exercised), so they're
-- LATENT — but each breaks a real user flow the moment it runs:
--
--   * 'insurance_premium'  → complete_ride_and_pay. trip_insurance_configs
--     has 5 ACTIVE rows, so insurance is offerable; completing an insured
--     ride would throw → driver can't finish the trip, rider uncharged.
--   * 'refund'             → process_recharge_refund (NETOPIA refund IPN).
--     A recharge reversal would throw → webhook 500 → NETOPIA retries
--     forever, refund never recorded on the wallet.
--   * 'quota_deduction'    → deduct_driver_quota (legacy, no live callers).
--   * 'quota_recharge'     → recharge_driver_quota / process_stripe_driver_quota_recharge
--     (legacy quota path, no live callers).
--
-- Fix = make the values the RPCs already use VALID. Additive + idempotent
-- (ADD VALUE IF NOT EXISTS); no function body changes, no data touched. This
-- also reconciles the enum with packages/types LedgerEntryType, which already
-- listed quota_deduction/quota_recharge (and now lists insurance_premium/refund).
--
-- Note: ADD VALUE only appends labels; existing rows and ordering are
-- untouched. Safe to re-run.
-- ============================================================================

ALTER TYPE public.ledger_entry_type ADD VALUE IF NOT EXISTS 'insurance_premium';
ALTER TYPE public.ledger_entry_type ADD VALUE IF NOT EXISTS 'refund';
ALTER TYPE public.ledger_entry_type ADD VALUE IF NOT EXISTS 'quota_deduction';
ALTER TYPE public.ledger_entry_type ADD VALUE IF NOT EXISTS 'quota_recharge';
