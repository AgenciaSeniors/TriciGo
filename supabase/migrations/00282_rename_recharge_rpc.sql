-- ============================================================
-- Migration 00282: Rename process_stripe_recharge → process_recharge_payment
--
-- Tech-debt cleanup of the Stripe→NETOPIA cutover (PR #137, #140).
-- The RPC that credits a payment_intent's wallet was originally
-- named `process_stripe_recharge`, but since the cutover it's been
-- called by NETOPIA's webhook too and is provider-agnostic in its
-- logic. PAYMENT_PROVIDER_CONTRACT.md §3 documented the planned
-- rename to `process_recharge_payment`; this migration lands it.
--
-- Strategy: zero-downtime rename.
--   1. CREATE OR REPLACE the new name `process_recharge_payment`
--      with the generalized body (provider-derived description +
--      metadata).
--   2. REPLACE `process_stripe_recharge` body with a one-line
--      wrapper that calls the new name. Any existing caller (e.g.
--      Sentry retroactive replay, cron, archived edge functions)
--      keeps working.
--   3. NETOPIA's webhook is updated in the same PR to call the new
--      name directly. Stripe webhook is gone since PR #137. A
--      future cleanup PR can `DROP FUNCTION process_stripe_recharge`
--      once we confirm no external caller remains.
--
-- IDEMPOTENCY KEY UNCHANGED. Historical ledger_transactions rows
-- use `stripe_recharge_<uuid>` as their idempotency_key. The new
-- function intentionally KEEPS that prefix — the key is an opaque
-- internal handle, never user-visible, and changing the prefix
-- would risk double-crediting on re-processing of old intents
-- (the SELECT lookup wouldn't find the existing txn). The
-- `metadata.payment_provider` field already carries the real
-- provider value, so there is no information loss.
--
-- WEBHOOK PAYLOAD KEY RENAMED. The metadata field that used to be
-- `stripe_pi_id` is now `provider_intent_id` for clarity (NETOPIA
-- stores its ntpID in the same payment_intents column, which we
-- have not renamed yet). Old rows keep `stripe_pi_id` in their
-- metadata since they were written before this migration.
-- ============================================================

-- 1. New generalized RPC.
CREATE OR REPLACE FUNCTION public.process_recharge_payment(
  p_payment_intent_id uuid,
  p_webhook_payload jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_intent RECORD;
  v_account_id UUID;
  v_account_user UUID;
  v_account_type TEXT;
  v_txn_id UUID;
  v_idempotency_key TEXT;
  v_provider TEXT;
  v_provider_label TEXT;
BEGIN
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE id = p_payment_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  IF v_intent.status = 'completed' THEN
    RETURN v_intent.transaction_id;
  END IF;

  IF v_intent.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Payment intent status is %, expected pending/processing', v_intent.status;
  END IF;

  -- Provider label for the human-readable description. Falls back to
  -- the raw value so historical/test providers still produce a row.
  v_provider := COALESCE(v_intent.payment_provider, 'unknown');
  v_provider_label := CASE v_provider
    WHEN 'netopia'   THEN 'NETOPIA'
    WHEN 'stripe'    THEN 'Stripe'
    WHEN 'euplatesc' THEN 'EuPlatesc'
    WHEN 'tropipay'  THEN 'TropiPay'
    ELSE v_provider
  END;

  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user FROM corporate_accounts WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found for intent %', v_intent.corporate_account_id, p_payment_intent_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSE
    v_account_user := v_intent.user_id;
    v_account_type := 'customer_cash';
  END IF;

  SELECT id INTO v_account_id
  FROM wallet_accounts
  WHERE user_id = v_account_user AND account_type = v_account_type::wallet_account_type;

  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_account_user, v_account_type::wallet_account_type, 0, 0, 'TRC', true)
    RETURNING id INTO v_account_id;
  END IF;

  -- Keep the legacy 'stripe_recharge_' prefix INTENTIONALLY. The key
  -- is an opaque internal idempotency handle and historical rows use
  -- it; changing the prefix would risk double-crediting on replay.
  v_idempotency_key := 'stripe_recharge_' || p_payment_intent_id::TEXT;

  SELECT id INTO v_txn_id
  FROM ledger_transactions
  WHERE idempotency_key = v_idempotency_key;

  IF v_txn_id IS NOT NULL THEN
    UPDATE payment_intents
    SET status = 'completed', transaction_id = v_txn_id,
        webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
        paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
    WHERE id = p_payment_intent_id;
    RETURN v_txn_id;
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key, 'recharge', 'posted', 'payment_intent',
    p_payment_intent_id,
    v_provider_label || ' wallet recharge: ' || v_intent.amount_cup || ' CUP (~$' || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    jsonb_build_object(
      'payment_provider', v_provider,
      'provider_intent_id', v_intent.stripe_payment_intent_id,
      'amount_usd', v_intent.amount_usd,
      'exchange_rate', v_intent.exchange_rate,
      'fee_usd', v_intent.fee_usd,
      'account_type', v_account_type,
      'corporate_account_id', v_intent.corporate_account_id
    ),
    v_intent.user_id
  ) RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (
    v_txn_id, v_account_id, v_intent.amount_cup,
    (SELECT balance FROM wallet_accounts WHERE id = v_account_id) + v_intent.amount_cup
  );

  UPDATE wallet_accounts
  SET balance = balance + v_intent.amount_cup, updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE payment_intents
  SET status = 'completed', transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      paid_at = NOW(), updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$function$;

-- 2. Convert legacy name into a thin wrapper. Preserves anything that
--    still calls `process_stripe_recharge` (no breakage during the
--    rename rollout).
CREATE OR REPLACE FUNCTION public.process_stripe_recharge(
  p_payment_intent_id uuid,
  p_webhook_payload jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Backwards-compat shim. New code should call
  -- process_recharge_payment directly. This wrapper will be removed
  -- in a follow-up cleanup migration once no callers remain.
  RETURN public.process_recharge_payment(p_payment_intent_id, p_webhook_payload);
END;
$function$;

-- 3. Lock down EXECUTE — same grants as the original.
REVOKE ALL ON FUNCTION public.process_recharge_payment(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_recharge_payment(uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.process_stripe_recharge(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_stripe_recharge(uuid, jsonb) TO service_role;
