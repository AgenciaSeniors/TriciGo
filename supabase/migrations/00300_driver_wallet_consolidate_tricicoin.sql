-- ============================================================
-- Migration 00300: Consolidar wallet driver a `tricicoin` (single-wallet model)
--
-- Bug arquitectónico reportado por user durante test del ride be1b9a37:
--   "el conductor pudo aceptar sin tener Tricicoin"
--
-- Realidad verificada en prod (Eduardo Admin):
--   tricicoin       =     920 TC  ← gate accept_ride_v2 + complete_ride_and_pay debit
--   driver_quota    = 22,260 TC  ← recharges NETOPIA acreditadas aquí
--   driver_cash     = -60,513 TC ← legacy backfill BUG-211, dead
--
-- Flow roto:
--   Driver recharge NETOPIA → create-netopia-payment-intent recibía
--   recharge_type='driver_quota' → persistía en payment_intents → webhook
--   llamaba process_recharge_payment → ESTE NO ROUTEABA a driver_quota
--   (la 00284 lo agregó pero 00293 lo sobrescribió al validar amount).
--   Las recargas legacy quedaron en driver_quota; las nuevas caen a
--   customer_cash por default. Mientras tanto tricicoin solo recibe el
--   seed inicial (00228) y se agota con cada comisión cobrada.
--
-- Decisión del user: TODO va a `tricicoin`. Single-wallet model.
--
-- Cambios:
--   1) Extender el CHECK de payment_intents.recharge_type para aceptar 'tricicoin'.
--   2) Rewrite process_recharge_payment con routing correcto:
--        corporate_account_id IS NOT NULL → corporate_cash
--        recharge_type IN ('tricicoin', 'driver_quota') → tricicoin
--        else (customer) → customer_cash
--      ('driver_quota' queda como ALIAS legacy mapeado a tricicoin, para
--      que clientes con versiones viejas del app sigan funcionando).
--   3) One-time backfill: mover balance de driver_quota → tricicoin para
--      cada driver, con ledger entries claros (debit driver_quota / credit
--      tricicoin, type='adjustment').
--   4) Marcar deduct_driver_quota deprecada (no la borra, sólo COMMENT;
--      el cleanup definitivo es Fase 2 cuando confirmemos cero callers).
--
-- Preserva intacto:
--   - get_driver_quota_status ya lee tricicoin (post-00284 follow-up).
--   - accept_ride_v2 chequea tricicoin via driver_can_afford_commission.
--   - complete_ride_and_pay debita comisión cash/mixed de tricicoin.
--   - Webhook process-netopia-webhook llama process_recharge_payment sin cambios.
-- ============================================================

-- ── 1) Aceptar 'tricicoin' en el CHECK de recharge_type ──
ALTER TABLE public.payment_intents
  DROP CONSTRAINT IF EXISTS payment_intents_recharge_type_chk;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_recharge_type_chk
  CHECK (recharge_type IN ('customer', 'driver_quota', 'tricicoin'));

COMMENT ON COLUMN public.payment_intents.recharge_type IS
  '00300: customer (default → customer_cash), tricicoin (driver/admin → tricicoin), '
  'driver_quota (legacy alias → tricicoin para retrocompatibilidad de clients viejos).';

-- ── 2) Redefinir process_recharge_payment con routing a tricicoin ──
CREATE OR REPLACE FUNCTION public.process_recharge_payment(
  p_payment_intent_id uuid,
  p_webhook_payload jsonb DEFAULT NULL::jsonb
) RETURNS uuid
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
  v_webhook_amount_raw TEXT;
  v_webhook_currency TEXT;
  v_webhook_amount NUMERIC;
  v_expected_amount NUMERIC;
  v_tolerance NUMERIC := 0.05;
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

  -- CC-03: webhook amount cross-check (preserved from 00293)
  IF p_webhook_payload IS NOT NULL THEN
    v_webhook_amount_raw := p_webhook_payload->>'amount';
    v_webhook_currency := UPPER(COALESCE(p_webhook_payload->>'currency', ''));

    IF v_webhook_amount_raw IS NOT NULL
       AND v_webhook_currency = 'USD'
       AND v_intent.amount_usd IS NOT NULL THEN
      BEGIN
        v_webhook_amount := v_webhook_amount_raw::NUMERIC;
      EXCEPTION WHEN OTHERS THEN
        v_webhook_amount := NULL;
      END;

      IF v_webhook_amount IS NOT NULL THEN
        v_expected_amount := v_intent.amount_usd::NUMERIC;
        v_amount_delta := ABS(v_webhook_amount - v_expected_amount);

        IF v_expected_amount > 0 AND (v_amount_delta / v_expected_amount) > v_tolerance THEN
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

  v_provider := COALESCE(v_intent.payment_provider, 'unknown');
  v_provider_label := CASE v_provider
    WHEN 'netopia'   THEN 'NETOPIA'
    WHEN 'stripe'    THEN 'Stripe'
    WHEN 'euplatesc' THEN 'EuPlatesc'
    WHEN 'tropipay'  THEN 'TropiPay'
    ELSE v_provider
  END;

  -- ── 00300 ROUTING ──
  -- Order matters: corporate_account_id wins (B2B has its own ledger).
  -- Then driver/tricicoin (single-wallet model). Default customer_cash.
  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user FROM corporate_accounts WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found for intent %', v_intent.corporate_account_id, p_payment_intent_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSIF v_intent.recharge_type IN ('tricicoin', 'driver_quota') THEN
    -- driver_quota es alias legacy de tricicoin (compatibilidad con clients
    -- pre-00300). Ambos terminan en account_type='tricicoin'.
    v_account_user := v_intent.user_id;
    v_account_type := 'tricicoin';
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
      'corporate_account_id', v_intent.corporate_account_id,
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

COMMENT ON FUNCTION public.process_recharge_payment(uuid, jsonb) IS
  '00300: routing 3-branch. corporate_account_id → corporate_cash. '
  'recharge_type IN (tricicoin, driver_quota) → tricicoin (single-wallet driver model). '
  'else → customer_cash. driver_quota es alias legacy preservado para '
  'retrocompatibilidad con clients pre-00300 (rechargeType=driver_quota '
  'sigue routeando al lugar correcto).';

-- ── 3) One-time backfill: driver_quota → tricicoin ──
--
-- Para cada wallet driver_quota con balance > 0, transferir a tricicoin
-- mediante 2 ledger entries dentro de la misma transaction:
--   - debit  driver_quota -balance  (queda en 0)
--   - credit tricicoin     +balance  (queda con (existente + transferido))
--
-- Idempotency key per-driver para evitar re-aplicación.

DO $$
DECLARE
  rec RECORD;
  v_tricicoin_account_id UUID;
  v_tricicoin_balance INTEGER;
  v_txn_id UUID;
  v_idem_key TEXT;
BEGIN
  FOR rec IN
    SELECT
      dq.id AS dq_account_id,
      dq.user_id,
      dq.balance AS dq_balance
    FROM wallet_accounts dq
    WHERE dq.account_type = 'driver_quota'
      AND dq.balance > 0
  LOOP
    v_idem_key := '00300_backfill_dq_to_tc:' || rec.user_id::TEXT;

    -- Skip si ya fue aplicado (idempotency)
    IF EXISTS (
      SELECT 1 FROM ledger_transactions WHERE idempotency_key = v_idem_key
    ) THEN
      CONTINUE;
    END IF;

    -- Ensure tricicoin account exists
    SELECT id, balance INTO v_tricicoin_account_id, v_tricicoin_balance
    FROM wallet_accounts
    WHERE user_id = rec.user_id AND account_type = 'tricicoin'
    FOR UPDATE;

    IF v_tricicoin_account_id IS NULL THEN
      INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
      VALUES (rec.user_id, 'tricicoin', 0, 0, 'TRC', true)
      RETURNING id, balance INTO v_tricicoin_account_id, v_tricicoin_balance;
    END IF;

    -- Lock the driver_quota row
    PERFORM 1 FROM wallet_accounts WHERE id = rec.dq_account_id FOR UPDATE;

    v_txn_id := gen_random_uuid();
    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, description, created_by)
    VALUES (v_txn_id, v_idem_key, 'adjustment', 'posted', 'migration',
      'Migration 00300: consolidate driver wallet — move ' || rec.dq_balance ||
      ' TC from driver_quota to tricicoin (single-wallet model).',
      rec.user_id);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, rec.dq_account_id, -rec.dq_balance, 0);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_tricicoin_account_id, rec.dq_balance, v_tricicoin_balance + rec.dq_balance);

    UPDATE wallet_accounts SET balance = 0, updated_at = NOW() WHERE id = rec.dq_account_id;
    UPDATE wallet_accounts SET balance = v_tricicoin_balance + rec.dq_balance, updated_at = NOW() WHERE id = v_tricicoin_account_id;
  END LOOP;
END $$;

-- ── 4) Deprecation marker para deduct_driver_quota ──
--
-- Esta función no es llamada por complete_ride_and_pay (verificado al leer
-- el source en prod), pero existe en disk de migraciones viejas. La marcamos
-- deprecated por claridad; el drop definitivo va en Fase 2 tras auditoría
-- de callers.

COMMENT ON FUNCTION public.deduct_driver_quota(uuid, uuid, integer) IS
  '00300 DEPRECATED: usar complete_ride_and_pay path (debita comisión de tricicoin). '
  'Esta función no debería ser llamada por nuevo código. Drop pendiente en Fase 2.';

COMMENT ON FUNCTION public.recharge_driver_quota(uuid, integer, text) IS
  '00300 DEPRECATED: usar process_recharge_payment con recharge_type=tricicoin. '
  'Esta función todavía existe para admin tools legacy pero credita driver_quota '
  '(que ya no se usa). Drop pendiente en Fase 2.';

COMMENT ON FUNCTION public.process_stripe_driver_quota_recharge(uuid, jsonb) IS
  '00300 DEPRECATED: la canonical entry-point es process_recharge_payment '
  'que rutea via payment_intents.recharge_type. Esta función legacy todavía '
  'credita driver_quota (incorrect post-00300). Drop pendiente en Fase 2.';
