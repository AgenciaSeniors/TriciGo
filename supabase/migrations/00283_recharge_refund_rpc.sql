-- ============================================================
-- Migration 00283: Refund RPC + abandoned-intent expiration cron
--
-- Part of the Recarga V2 plan (locked Oct/Nov 2026 in design rounds 1-4).
-- This migration adds two pieces that didn't exist before:
--
-- 1. process_recharge_refund(uuid, jsonb) RPC — reverses a completed
--    recharge by debiting the wallet of the credited amount. Mirrors
--    process_recharge_payment in reverse. NEGATIVE BALANCE ALLOWED
--    (admin regularizes manually). Called by process-netopia-webhook
--    when NETOPIA sends a status='refunded' IPN.
--
-- 2. expire-stale-payment-intents cron — every 15 min, marks any
--    payment_intent that has been in 'created'/'pending' status for
--    more than 1 hour as 'expired'. NETOPIA's hosted payment page
--    session also expires within ~1h, so anything older can't be
--    completed anyway.
--
-- Idempotency on the refund RPC uses idempotency_key
-- 'recharge_refund_<intent_id>' so re-running the webhook with the
-- same refund event is safe (returns the same refund txn_id).
-- ============================================================

-- ── 1. The refund RPC ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_recharge_refund(
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
  v_refund_txn_id UUID;
  v_idempotency_key TEXT;
BEGIN
  -- Lock the intent row to prevent race with concurrent webhook events.
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE id = p_payment_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  -- Only refund completed recharges. Re-runs are idempotent: if the
  -- intent is already 'refunded', return the existing refund txn id.
  IF v_intent.status = 'refunded' THEN
    SELECT id INTO v_refund_txn_id
    FROM ledger_transactions
    WHERE idempotency_key = 'recharge_refund_' || p_payment_intent_id::TEXT;
    RETURN v_refund_txn_id;
  END IF;

  IF v_intent.status <> 'completed' THEN
    RAISE EXCEPTION 'Cannot refund intent in status %; expected completed', v_intent.status;
  END IF;

  -- Resolve wallet account (mirror of process_recharge_payment).
  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user
    FROM corporate_accounts
    WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found for intent %',
        v_intent.corporate_account_id, p_payment_intent_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSE
    v_account_user := v_intent.user_id;
    v_account_type := 'customer_cash';
  END IF;

  SELECT id INTO v_account_id
  FROM wallet_accounts
  WHERE user_id = v_account_user
    AND account_type = v_account_type::wallet_account_type;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Wallet account not found for refund of intent %',
      p_payment_intent_id;
  END IF;

  v_idempotency_key := 'recharge_refund_' || p_payment_intent_id::TEXT;

  -- Idempotency: if a refund txn already exists for this key, return it.
  SELECT id INTO v_refund_txn_id
  FROM ledger_transactions
  WHERE idempotency_key = v_idempotency_key;
  IF v_refund_txn_id IS NOT NULL THEN
    UPDATE payment_intents
    SET status = 'refunded',
        webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
        updated_at = NOW()
    WHERE id = p_payment_intent_id;
    RETURN v_refund_txn_id;
  END IF;

  -- Insert the reversal ledger_transaction. amount on the ledger_entry
  -- is NEGATIVE (debit). reference_type/id link back to the original
  -- payment_intent for audit.
  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key,
    'refund',
    'posted',
    'payment_intent',
    p_payment_intent_id,
    'Refund of wallet recharge: -' || v_intent.amount_cup || ' CUP (~-$'
      || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    jsonb_build_object(
      'payment_provider', v_intent.payment_provider,
      'provider_intent_id', v_intent.stripe_payment_intent_id,
      'refund_amount_cup', v_intent.amount_cup,
      'refund_amount_usd', v_intent.amount_usd,
      'corporate_account_id', v_intent.corporate_account_id,
      'webhook_payload', p_webhook_payload
    ),
    v_intent.user_id
  ) RETURNING id INTO v_refund_txn_id;

  -- Debit the wallet (negative amount). Negative balance is permitted
  -- so the admin can regularize when the user has already spent.
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (
    v_refund_txn_id,
    v_account_id,
    -v_intent.amount_cup,
    (SELECT balance FROM wallet_accounts WHERE id = v_account_id) - v_intent.amount_cup
  );

  UPDATE wallet_accounts
  SET balance = balance - v_intent.amount_cup,
      updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE payment_intents
  SET status = 'refunded',
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_refund_txn_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_recharge_refund(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_recharge_refund(uuid, jsonb) TO service_role;


-- ── 2. The expire-stale-payment-intents cron ─────────────────
-- Marks any 'created'/'pending' intent older than 1 hour as 'expired'.
-- Runs every 15 minutes. NETOPIA's hosted page session also expires
-- around 1h, so this aligns with reality.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-stale-payment-intents') THEN
    PERFORM cron.unschedule('expire-stale-payment-intents');
  END IF;
END $$;

SELECT cron.schedule(
  'expire-stale-payment-intents',
  '*/15 * * * *',
  $cmd$
  UPDATE payment_intents
  SET status = 'expired',
      error_message = COALESCE(error_message, 'abandoned: no completion within 1h'),
      updated_at = NOW()
  WHERE status IN ('created', 'pending')
    AND created_at < NOW() - INTERVAL '1 hour';
  $cmd$
);
