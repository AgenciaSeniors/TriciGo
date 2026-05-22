-- ============================================================
-- Migration 00284 — recharge_type column + driver_quota routing
-- ============================================================
--
-- Bug found during E2E test of PR #144 (Recarga V2 driver flow):
--   The driver app sends `rechargeType: 'driver_quota'` to the EF
--   `create-netopia-payment-intent`, but:
--     1. The EF destructures the field and never persists it.
--     2. The RPC `process_recharge_payment` only branches on
--        `corporate_account_id IS NOT NULL` → corporate_cash, else
--        defaults to `customer_cash`. There is NO `driver_quota`
--        branch.
--   Result: every driver recharge gets credited to the user's
--   `customer_cash` wallet (the rider account) instead of the
--   `driver_quota` account (the commission credit).
--
--   For users that have both roles (super_admin + driver_profiles
--   like Eduardo), the wallet exists in both — the recharge just
--   landed in the wrong one. For driver-only users, the recharge
--   created a `customer_cash` account out of nowhere.
--
-- This migration:
--   1. Adds `payment_intents.recharge_type` (NOT NULL DEFAULT
--      'customer') so the routing decision is persisted at intent
--      creation time and can be replayed by the webhook.
--   2. Backfills existing rows: NULL → 'customer' (the historical
--      default).
--   3. Rewrites `process_recharge_payment` to branch on
--      `recharge_type` BEFORE falling back to customer_cash:
--        - corporate_account_id IS NOT NULL → corporate_cash
--        - recharge_type = 'driver_quota'   → driver_quota
--        - else                              → customer_cash
--
-- Non-destructive: CREATE OR REPLACE on the RPC, ALTER TABLE ADD
-- COLUMN with safe default. No data loss.
--
-- The legacy `recharge_driver_quota` RPC (migration 00094:377) is
-- left alone — admin tools may still call it for manual top-ups.
-- ============================================================

-- 1. Add the column (NOT NULL with safe default keeps existing rows valid).
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS recharge_type text NOT NULL DEFAULT 'customer';

-- 2. Constraint: only allow the values we actually route on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payment_intents_recharge_type_chk'
  ) THEN
    ALTER TABLE payment_intents
      ADD CONSTRAINT payment_intents_recharge_type_chk
      CHECK (recharge_type IN ('customer', 'driver_quota'));
  END IF;
END $$;

-- 3. Rewrite the RPC with driver_quota routing.
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

  v_provider := COALESCE(v_intent.payment_provider, 'unknown');
  v_provider_label := CASE v_provider
    WHEN 'netopia'   THEN 'NETOPIA'
    WHEN 'stripe'    THEN 'Stripe'
    WHEN 'euplatesc' THEN 'EuPlatesc'
    WHEN 'tropipay'  THEN 'TropiPay'
    ELSE v_provider
  END;

  -- ROUTING — order matters:
  --   1. corporate_account_id wins over recharge_type (the corporate
  --      account is the explicit owner of the credit).
  --   2. recharge_type = 'driver_quota' → the driver's commission
  --      credit account.
  --   3. fallback → the user's own customer_cash wallet.
  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user FROM corporate_accounts WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found for intent %', v_intent.corporate_account_id, p_payment_intent_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSIF v_intent.recharge_type = 'driver_quota' THEN
    v_account_user := v_intent.user_id;
    v_account_type := 'driver_quota';
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

  -- Keep the legacy 'stripe_recharge_' prefix INTENTIONALLY for
  -- idempotency continuity with historical rows.
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
      'recharge_type', v_intent.recharge_type,
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

-- 4. Verification snippets (run manually after apply):
--
--   SELECT recharge_type, COUNT(*)
--   FROM payment_intents
--   GROUP BY recharge_type;
--   -- expected: only 'customer' until the EF starts persisting
--   -- 'driver_quota' for new driver recharges.
--
--   SELECT proname, prosrc FROM pg_proc WHERE proname = 'process_recharge_payment';
--   -- confirm the body contains "recharge_type = 'driver_quota'".
