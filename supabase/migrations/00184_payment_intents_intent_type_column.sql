-- ============================================================
-- BUG-127: the Edge Functions create-stripe-payment-intent and
-- process-stripe-webhook both reference a column `intent_type`
-- on payment_intents that does not exist in the table schema:
--
--   create-stripe-payment-intent (INSERT):
--     intentRow.intent_type = 'recharge'
--   process-stripe-webhook (SELECT):
--     .select('id, status, user_id, amount_cup, intent_type, ...')
--
-- Effect: both calls fail at PostgREST level. Customers tapping
-- "Pay with Stripe" hit a "db_error" with the column message, and
-- — even if the INSERT succeeded — the webhook would 404 on the
-- existingIntent lookup and never credit the wallet. Stripe was
-- de-facto disabled.
--
-- Cheapest safe fix: add the column. The Edge Functions both
-- write the constant 'recharge', so no business logic changes
-- here; this is just lining the schema up with the running code.
-- A separate cleanup pass can drop intent_type once the EF code
-- stops writing it (it's not consumed anywhere).
-- ============================================================

ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS intent_type text;

-- Backfill so any existing intents created via TropiPay (which
-- ignored this column) get a sane non-NULL default.
UPDATE public.payment_intents
SET intent_type = 'recharge'
WHERE intent_type IS NULL;

COMMENT ON COLUMN public.payment_intents.intent_type IS
  'BUG-127: present so Stripe Edge Function INSERT/SELECT both succeed. Currently always "recharge"; reserved for future ride-payment / driver_quota specialization.';
