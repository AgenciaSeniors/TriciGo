-- ============================================================
-- BUG-104: process_stripe_recharge passed p_payment_intent_id::TEXT
-- to ledger_transactions.reference_id, which is a uuid column. Every
-- call raised:
--   "column reference_id is of type uuid but expression is of type text"
--
-- Bug existed in the original migration 00110 (stripe_integration)
-- and was preserved in 00162 (corporate routing fix). Discovered only
-- during E2E testing since Stripe recharge had never actually been
-- invoked in prod (0 rows in payment_intents at fix time).
--
-- Fix: drop the ::TEXT cast so reference_id receives a uuid.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_stripe_recharge(p_payment_intent_id uuid, p_webhook_payload jsonb DEFAULT NULL::jsonb)
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
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id; END IF;
  IF v_intent.status = 'completed' THEN RETURN v_intent.transaction_id; END IF;
  IF v_intent.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Payment intent status is %, expected pending/processing', v_intent.status;
  END IF;

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

  SELECT id INTO v_account_id FROM wallet_accounts
  WHERE user_id = v_account_user AND account_type = v_account_type::wallet_account_type;

  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_account_user, v_account_type::wallet_account_type, 0, 0, 'TRC', true)
    RETURNING id INTO v_account_id;
  END IF;

  v_idempotency_key := 'stripe_recharge_' || p_payment_intent_id::TEXT;

  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
    WHERE id = p_payment_intent_id;
    RETURN v_txn_id;
  END IF;

  -- BUG-104 fix: reference_id is uuid, drop the superfluous ::TEXT cast.
  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key, 'recharge', 'posted', 'payment_intent',
    p_payment_intent_id,
    'Stripe wallet recharge: ' || v_intent.amount_cup || ' CUP (~$' || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    jsonb_build_object('payment_provider', 'stripe', 'stripe_pi_id', v_intent.stripe_payment_intent_id,
      'amount_usd', v_intent.amount_usd, 'exchange_rate', v_intent.exchange_rate,
      'fee_usd', v_intent.fee_usd, 'account_type', v_account_type,
      'corporate_account_id', v_intent.corporate_account_id),
    v_intent.user_id
  ) RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_intent.amount_cup,
    (SELECT balance FROM wallet_accounts WHERE id = v_account_id) + v_intent.amount_cup);

  UPDATE wallet_accounts SET balance = balance + v_intent.amount_cup, updated_at = NOW() WHERE id = v_account_id;
  UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    paid_at = NOW(), updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$function$;
