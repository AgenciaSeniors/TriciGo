-- ============================================================
-- BUG-166 (CRITICAL): four webhook-processing RPCs are EXECUTE-
-- granted to anon and authenticated. They mark a payment_intent
-- as 'completed' and credit the user's wallet without re-running
-- any payment-provider verification. The Edge Functions are
-- supposed to be the only callers (after they verify the TropiPay
-- or Stripe webhook signature), but the RPCs were never restricted.
--
-- Concrete exploit:
--   1. Attacker (or anyone) observes a `payment_intents` row in
--      'created' state (e.g., another user just opened the
--      checkout but hasn't paid yet).
--   2. Attacker calls process_tropipay_payment(p_payment_intent_id)
--      directly via PostgREST.
--   3. The intent flips to 'completed', the user's wallet is
--      credited, no actual payment happened.
--   4. The legitimate webhook arrives later and is a no-op
--      (idempotent on the 'completed' status).
--   5. The user never actually paid TropiPay → free money.
--
-- The same exploit applies to all 4 functions. Anon access is
-- worse — no auth needed at all.
--
-- Fix: revoke EXECUTE from PUBLIC, anon, authenticated. Only
-- service_role (used by the EF after signature verification) is
-- allowed.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.process_tropipay_payment(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_corporate_tropipay_payment(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_stripe_recharge(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_stripe_driver_quota_recharge(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- service_role retains EXECUTE (it owns the schema by default in Supabase).
-- Verify post-state explicitly so a reviewer can spot any drift.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT unnest(ARRAY['process_tropipay_payment','process_corporate_tropipay_payment',
                               'process_stripe_recharge','process_stripe_driver_quota_recharge']) AS fn
  LOOP
    IF has_function_privilege('authenticated', ('public.'||r.fn||'(uuid,jsonb)')::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.'||r.fn||'(uuid,jsonb)')::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'BUG-166 NOT FIXED: % still callable by anon/authenticated', r.fn;
    END IF;
  END LOOP;
END $$;
