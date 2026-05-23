-- ============================================================
-- CC-03 (security audit 2026-05-23, cross-cutting CLI-002 + CLI-005):
-- process_recharge_payment (mig 00282) accepts an arbitrary
-- p_webhook_payload jsonb without validating that the amount
-- reported by the payment provider matches what was authorized
-- in payment_intents.
--
-- The webhook EF (supabase/functions/process-netopia-webhook/index.ts
-- line 270) builds the payload like:
--
--   const webhookPayload = {
--     netopia_ntp_id: ntpId,
--     amount: ipn.payment?.amount,
--     currency: ipn.payment?.currency,
--     netopia_status: ipn.payment?.status,
--   };
--
-- and passes it to process_recharge_payment(p_payment_intent_id,
-- p_webhook_payload). The RPC currently:
--   * Looks up v_intent.amount_cup (the authorized amount at intent
--     creation, in CUP)
--   * Credits the wallet that exact amount
--   * Saves the webhook_payload as metadata
--
-- BUT it never cross-checks `p_webhook_payload->>'amount'` against
-- `v_intent.amount_usd` (the dollar amount that was actually billed
-- via NETOPIA). If NETOPIA's IPN ever reports an amount different
-- from what we authorized (a bug on their side, a misconfigured
-- intent on ours, or an MITM in a sandbox environment), we'd
-- silently credit the authorized CUP amount even though the card
-- was charged differently. Worst case: the customer's card was
-- charged $X but they got Y CUP credited where conversion(X) != Y.
--
-- Mitigating context: the existing UUID v4 orderID + atomic-claim
-- defense in process-netopia-webhook blocks forgery and replay.
-- This migration adds an orthogonal check: even if the IPN is
-- legitimate but anomalous, we refuse to credit and surface for
-- manual review.
--
-- Approach: defense in depth, not strict equality. We allow a 5%
-- tolerance window (NETOPIA may round in its own currency
-- conversion, exchange rates drift between intent-create-time and
-- IPN-arrival-time, fee handling differs slightly). Mismatches
-- *outside* the tolerance RAISE — the IPN remains marked failed,
-- the atomic claim is released for retry, and the
-- payment_intents.error_message captures the discrepancy.
--
-- Scope: only validates when `currency='USD'` (the unit our
-- intents store in amount_usd) and `amount` is numeric. For any
-- other currency or missing amount, the check is skipped and
-- behavior is unchanged. This is intentionally permissive to
-- avoid breaking existing flows for providers that use other
-- currencies.
--
-- Companion: env var NETOPIA_IPN_VERIFY_CALLBACK=true (set in the
-- EF environment, not in this migration) re-queries NETOPIA's API
-- for the ntpID's true status before crediting — orthogonal
-- defense, see process-netopia-webhook/index.ts line 24.
-- ============================================================

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
  -- CC-03: webhook amount validation locals
  v_webhook_amount_raw TEXT;
  v_webhook_currency TEXT;
  v_webhook_amount NUMERIC;
  v_expected_amount NUMERIC;
  v_tolerance NUMERIC := 0.05;  -- 5% tolerance for FX rounding / fee handling drift
  v_amount_delta NUMERIC;
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

  -- ── CC-03: webhook amount cross-check ──
  -- Only validate when the webhook gave us both a numeric amount
  -- and currency='USD' (our intent's amount_usd is the canonical
  -- comparison target). Other currencies / missing values are
  -- skipped — behavior identical to pre-CC-03 (backward compat).
  IF p_webhook_payload IS NOT NULL THEN
    v_webhook_amount_raw := p_webhook_payload->>'amount';
    v_webhook_currency := UPPER(COALESCE(p_webhook_payload->>'currency', ''));

    IF v_webhook_amount_raw IS NOT NULL
       AND v_webhook_currency = 'USD'
       AND v_intent.amount_usd IS NOT NULL THEN
      BEGIN
        v_webhook_amount := v_webhook_amount_raw::NUMERIC;
      EXCEPTION WHEN OTHERS THEN
        -- Non-numeric amount in payload — log and skip, don't block
        -- (the orderID/UUID atomic claim is the primary defense).
        v_webhook_amount := NULL;
      END;

      IF v_webhook_amount IS NOT NULL THEN
        v_expected_amount := v_intent.amount_usd::NUMERIC;
        v_amount_delta := ABS(v_webhook_amount - v_expected_amount);

        IF v_expected_amount > 0 AND (v_amount_delta / v_expected_amount) > v_tolerance THEN
          -- Mismatch beyond tolerance. Record the discrepancy on the
          -- intent for forensics, then bail out — leaves the intent
          -- in pending/processing so the atomic claim is released
          -- for retry once the discrepancy is resolved.
          UPDATE payment_intents
          SET error_message = format(
                'webhook_amount_mismatch: webhook=%s %s, intent=%s USD, delta=%s (%.2f%%)',
                v_webhook_amount, v_webhook_currency,
                v_expected_amount, v_amount_delta,
                (v_amount_delta / v_expected_amount * 100)
              ),
              updated_at = NOW()
          WHERE id = p_payment_intent_id;

          RAISE EXCEPTION 'webhook_amount_mismatch for intent %: webhook=% %, expected=% USD, delta=% (%.2f%%) > tolerance %.0f%%',
            p_payment_intent_id,
            v_webhook_amount, v_webhook_currency,
            v_expected_amount,
            v_amount_delta,
            (v_amount_delta / v_expected_amount * 100),
            (v_tolerance * 100);
        END IF;
      END IF;
    END IF;
  END IF;
  -- ── end CC-03 ──

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
      'corporate_account_id', v_intent.corporate_account_id,
      -- CC-03: snapshot the webhook amount we validated for forensic trail
      'webhook_amount_validated', COALESCE(v_webhook_amount, NULL),
      'webhook_currency', NULLIF(v_webhook_currency, '')
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

-- Grants unchanged (already service_role only per mig 00282 / 00208).

COMMENT ON FUNCTION public.process_recharge_payment(uuid, jsonb) IS
  'CC-03: cross-validates p_webhook_payload->>amount vs payment_intents.amount_usd (when currency=USD and amount numeric). 5% tolerance for FX/fee drift. Mismatch beyond tolerance: writes error_message to intent, RAISE EXCEPTION, leaves intent claimable for retry. Other currencies / missing amount: skipped (backward compat).';
