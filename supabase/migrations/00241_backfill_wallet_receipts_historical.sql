-- ============================================================
-- Backfill wallet_receipts for historical Stripe recharges (Wallet v2 PR 8/9)
-- ============================================================
-- Spec: docs/WALLET_V2_USD_MODEL.md §5.4
--
-- Inserts a wallet_receipts row for every completed Stripe recharge
-- in payment_intents that doesn't already have one. The row is
-- created with `pdf_storage_path = NULL` — the actual PDF is
-- generated lazily the first time someone (user clicking "Descargar
-- comprobante", admin retroactive trigger, or PR 9 admin UI) calls
-- the generate-recharge-receipt edge function for that
-- payment_intent_id. The EF (PR 2) already handles the
-- "row exists, PDF missing" path: it regenerates + uploads + stamps
-- pdf_storage_path / pdf_generated_at.
--
-- This means historical recharges immediately get a formal receipt
-- number (TG-2026-...) visible in the admin tab and tied to a
-- ledger transaction — even before anyone downloads the PDF.
--
-- Risk: low. INSERT-only, ON CONFLICT DO NOTHING via the implicit
-- payment_intent_id UNIQUE on wallet_receipts. Re-running the
-- migration is a no-op once the rows are populated.
-- ============================================================

INSERT INTO wallet_receipts (
  user_id,
  payment_intent_id,
  receipt_no,
  usd_charged,
  fee_usd,
  net_usd,
  tc_credited,
  exchange_rate,
  exchange_at,
  cup_equivalent,
  stripe_payment_intent_id,
  card_brand,
  card_last4,
  pdf_storage_path,
  pdf_generated_at
)
SELECT
  pi.user_id,
  pi.id AS payment_intent_id,
  generate_receipt_no() AS receipt_no,
  COALESCE(pi.amount_usd, 0) AS usd_charged,
  -- Fee: prefer the snapshot on the PI; fall back to spec §10 rule.
  COALESCE(
    NULLIF(pi.fee_usd, 0),
    GREATEST(COALESCE(pi.amount_usd, 0) * 0.03, 0.50)
  ) AS fee_usd,
  -- Net = charged - fee, clamped at 0.
  GREATEST(0, COALESCE(pi.amount_usd, 0) - COALESCE(
    NULLIF(pi.fee_usd, 0),
    GREATEST(COALESCE(pi.amount_usd, 0) * 0.03, 0.50)
  )) AS net_usd,
  -- Spec §1: 1 TC ≡ 1 USD, so tc_credited = net_usd.
  GREATEST(0, COALESCE(pi.amount_usd, 0) - COALESCE(
    NULLIF(pi.fee_usd, 0),
    GREATEST(COALESCE(pi.amount_usd, 0) * 0.03, 0.50)
  )) AS tc_credited,
  COALESCE(pi.exchange_rate, 0) AS exchange_rate,
  COALESCE(pi.paid_at, pi.created_at) AS exchange_at,
  -- CUP equivalent = net_usd × exchange_rate.
  COALESCE(pi.exchange_rate, 0) * GREATEST(0, COALESCE(pi.amount_usd, 0) - COALESCE(
    NULLIF(pi.fee_usd, 0),
    GREATEST(COALESCE(pi.amount_usd, 0) * 0.03, 0.50)
  )) AS cup_equivalent,
  COALESCE(pi.stripe_payment_intent_id, '') AS stripe_payment_intent_id,
  pi.card_brand,
  pi.card_last4,
  NULL::text AS pdf_storage_path,    -- generated lazily
  NULL::timestamptz AS pdf_generated_at
FROM payment_intents pi
WHERE pi.payment_provider = 'stripe'
  AND pi.status IN ('completed', 'succeeded')
  AND pi.amount_usd IS NOT NULL
  AND pi.amount_usd > 0
  AND NOT EXISTS (
    SELECT 1 FROM wallet_receipts wr
    WHERE wr.payment_intent_id = pi.id
  )
ON CONFLICT (payment_intent_id) DO NOTHING;

-- Verification (run after applying):
--   SELECT count(*) FILTER (WHERE pdf_storage_path IS NOT NULL) AS with_pdf,
--          count(*) FILTER (WHERE pdf_storage_path IS NULL)     AS missing_pdf
--   FROM wallet_receipts;
--
--   -- Confirm every Stripe-completed PI has a receipt:
--   SELECT count(*) AS missing_receipts
--   FROM payment_intents pi
--   WHERE pi.payment_provider = 'stripe'
--     AND pi.status IN ('completed', 'succeeded')
--     AND NOT EXISTS (SELECT 1 FROM wallet_receipts wr WHERE wr.payment_intent_id = pi.id);
--   -- expected: 0
