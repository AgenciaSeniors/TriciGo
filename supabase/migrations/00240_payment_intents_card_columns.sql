-- ============================================================
-- payment_intents: add card_brand + card_last4 (Wallet v2 PR 3/9)
-- ============================================================
-- Persists the card brand (visa, mastercard, amex, ...) and the
-- last 4 digits of the card used for a Stripe wallet recharge.
-- Both come from Stripe's PaymentMethod object and are populated
-- by the process-stripe-webhook EF on payment_intent.succeeded.
--
-- Consumed by generate-recharge-receipt (PR 2) so the legal PDF
-- shows "Visa terminada en •••• 4242" instead of the generic
-- "Tarjeta de crédito/débito (Stripe)" placeholder.
--
-- Risk: low. Both columns are nullable text, additive only.
-- Existing rows stay NULL until the next webhook fires for them.
-- ============================================================

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS card_last4 text;

-- Optional check constraint: last4 must be exactly 4 digits when set.
-- Skipped to keep the migration trivially reversible — Stripe
-- guarantees the format on its side anyway.
