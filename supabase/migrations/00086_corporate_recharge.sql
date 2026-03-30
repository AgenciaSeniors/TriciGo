-- ============================================================
-- Migration 00086: Corporate Wallet Recharge Support
-- Adds corporate_account_id to payment_intents so recharges
-- can target a corporate wallet instead of a personal wallet.
-- ============================================================

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS corporate_account_id UUID REFERENCES corporate_accounts(id);

CREATE INDEX IF NOT EXISTS idx_payment_intents_corporate
  ON payment_intents(corporate_account_id) WHERE corporate_account_id IS NOT NULL;

-- ============================================================
-- RPC: process_corporate_tropipay_payment
-- Credits the corporate wallet when a TropiPay payment with
-- corporate_account_id completes successfully.
-- ============================================================

CREATE OR REPLACE FUNCTION process_corporate_tropipay_payment(
  p_payment_intent_id UUID,
  p_webhook_payload JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_intent RECORD;
  v_txn_id UUID;
  v_trc_amount NUMERIC;
BEGIN
  -- Lock the intent row
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE id = p_payment_intent_id
  FOR UPDATE;

  IF v_intent IS NULL THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  IF v_intent.status = 'completed' THEN
    -- Already processed (idempotent)
    RETURN v_intent.transaction_id;
  END IF;

  IF v_intent.corporate_account_id IS NULL THEN
    RAISE EXCEPTION 'Not a corporate recharge intent';
  END IF;

  -- Convert CUP to TRC using exchange rate
  v_trc_amount := ROUND(v_intent.amount_cup::NUMERIC / COALESCE(v_intent.exchange_rate, 520), 2);

  -- Credit the corporate wallet
  UPDATE wallet_accounts
  SET balance = balance + v_trc_amount,
      updated_at = NOW()
  WHERE user_id = v_intent.corporate_account_id
    AND account_type = 'corporate_cash';

  -- Record a wallet transaction
  INSERT INTO wallet_transactions (
    account_id,
    amount,
    type,
    description,
    reference_id
  )
  SELECT
    wa.id,
    v_trc_amount,
    'credit',
    'Recarga corporativa TropiPay (' || v_intent.amount_cup || ' CUP)',
    p_payment_intent_id
  FROM wallet_accounts wa
  WHERE wa.user_id = v_intent.corporate_account_id
    AND wa.account_type = 'corporate_cash'
  RETURNING id INTO v_txn_id;

  -- Mark intent as completed
  UPDATE payment_intents
  SET status = 'completed',
      paid_at = NOW(),
      transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$$;
