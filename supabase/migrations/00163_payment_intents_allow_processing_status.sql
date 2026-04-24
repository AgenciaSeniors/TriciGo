-- ============================================================
-- BUG-103: payment_intents.status CHECK constraint lacks 'processing',
-- but the Stripe webhook (supabase/functions/process-stripe-webhook)
-- performs an atomic claim via:
--   UPDATE payment_intents SET status='processing'
--   WHERE id = ... AND status IN ('pending','created')
-- to guarantee only one webhook invocation processes a given intent.
-- Without 'processing' in the CHECK, that claim raises a constraint
-- violation and the entire Stripe recharge flow is broken in prod.
--
-- Discovered in BUG-102 verification (Test 4 Stripe recharge E2E).
-- 0 rows currently have status='processing' so the migration is safe.
-- ============================================================

ALTER TABLE public.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_check;
ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_status_check
  CHECK (status = ANY (ARRAY[
    'created'::text,
    'pending'::text,
    'processing'::text,
    'completed'::text,
    'failed'::text,
    'expired'::text,
    'refunded'::text
  ]));
