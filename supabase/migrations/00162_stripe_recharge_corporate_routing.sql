-- ============================================================
-- BUG-102: process_stripe_recharge hardcoded `account_type =
-- 'customer_cash'` and ignored `payment_intents.corporate_account_id`.
-- The webhook (process-stripe-webhook) has a comment "Corporate uses
-- same RPC (credits the corporate_account's wallet)" but the RPC
-- never implemented that branch — every corporate Stripe recharge
-- would have credited the admin user's customer_cash wallet instead
-- of the corporate_cash wallet belonging to corporate_accounts.created_by.
--
-- Production impact: 0 rows in payment_intents at fix time (Stripe
-- recharge not yet live), so no reconciliation needed. Fix is
-- additive: customer flow preserved exactly, corporate flow now
-- routes to corporate_cash of the corp's `created_by` owner.
--
-- NOTE: this migration introduced a latent ::TEXT cast bug on
-- reference_id that is fixed in 00164. Both are part of the same
-- BUG-102 rollout.
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

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key, 'recharge', 'posted', 'payment_intent',
    p_payment_intent_id::TEXT,  -- BUG-104: cast is wrong, reference_id is uuid. Fixed in 00164.
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
