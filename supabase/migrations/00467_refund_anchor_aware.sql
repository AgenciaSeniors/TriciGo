-- 00467 — Anchor-aware recharge refunds (FX anchor audit, Tema D / PR-FX-2)
--
-- Bug (verified vs prod; 0 refunds in history, so purely latent): process_recharge_refund
-- debits the wallet by the ORIGINAL amount_cup and lets tg_ledger_maintain_usd_anchor
-- remove anchor at TODAY's rate. When the rate moved between recharge and refund, the
-- anchor reduction != the USD the recharge added, leaving balance and anchor
-- inconsistent (a residue the next revaluation re-materializes or claws back, with a
-- spend-race window in between).
--
-- Fix:
--  (1) A general per-account "anchor directive" mechanism in the anchor trigger: a txn
--      whose metadata carries metadata.anchor_directives = [{account_id, anchor_usd_cents_delta,
--      unbacked_cup_delta}, ...] applies those EXACT deltas to the matching wallet,
--      bypassing the today-rate recompute and the unbacked-first heuristic. (Reused by
--      the leakage fixes in the next PR.)
--  (2) process_recharge_refund reverses the recharge at its ORIGINAL USD worth:
--      debit = round(original_usd_cents/100 * rate_today) (the recharge's current CUP
--      worth, which the daily revaluation already grew the balance to), and an explicit
--      directive removes exactly original_usd_cents from the anchor. Balance and anchor
--      land consistent immediately — no residue, no race. Legacy intents without
--      amount_usd/exchange_rate fall back to the old behavior (debit amount_cup, trigger
--      recompute).
--
-- Both functions are CREATE OR REPLACE of the verbatim live bodies plus the additions.

-- 1) Anchor trigger: add the explicit per-account directive path.
CREATE OR REPLACE FUNCTION public.tg_ledger_maintain_usd_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_type     public.wallet_account_type;
  v_txn_type public.ledger_entry_type;
  v_rate     numeric;
  v_spend    integer;
  v_meta     jsonb;
  v_dir      jsonb;
BEGIN
  SELECT account_type INTO v_type FROM public.wallet_accounts WHERE id = NEW.account_id;
  IF v_type IS NULL OR v_type NOT IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN
    RETURN NEW;
  END IF;

  SELECT type, metadata INTO v_txn_type, v_meta FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  IF v_txn_type IN ('fx_revaluation', 'ride_hold', 'ride_hold_release') THEN
    RETURN NEW;
  END IF;

  IF NEW.amount = 0 THEN RETURN NEW; END IF;

  -- Explicit per-account anchor directive: refunds / transfers / admin adjusts that
  -- know the exact backed/unbacked movement set it, bypassing the today-rate recompute.
  IF v_meta ? 'anchor_directives' AND jsonb_typeof(v_meta->'anchor_directives') = 'array' THEN
    SELECT d INTO v_dir
    FROM jsonb_array_elements(v_meta->'anchor_directives') d
    WHERE (d->>'account_id')::uuid = NEW.account_id
    LIMIT 1;
    IF v_dir IS NOT NULL THEN
      UPDATE public.wallet_accounts
         SET anchor_usd_cents = GREATEST(0, COALESCE(anchor_usd_cents, 0) + COALESCE((v_dir->>'anchor_usd_cents_delta')::numeric, 0)),
             unbacked_cup     = GREATEST(0, unbacked_cup + COALESCE((v_dir->>'unbacked_cup_delta')::integer, 0)),
             updated_at = now()
       WHERE id = NEW.account_id;
      RETURN NEW;
    END IF;
  END IF;

  IF v_txn_type = 'promo_credit' THEN
    IF NEW.amount < 0 THEN
      PERFORM 1 FROM public.wallet_accounts WHERE id = NEW.account_id AND unbacked_cup + NEW.amount < 0;
      IF FOUND THEN
        RAISE NOTICE 'promo_credit clawback exceeds unbacked balance for wallet % (entry %)', NEW.account_id, NEW.id;
      END IF;
    END IF;
    UPDATE public.wallet_accounts
       SET unbacked_cup = GREATEST(0, unbacked_cup + NEW.amount), updated_at = now()
     WHERE id = NEW.account_id;
    RETURN NEW;
  END IF;

  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.amount > 0 THEN
    UPDATE public.wallet_accounts
       SET anchor_usd_cents = COALESCE(anchor_usd_cents, 0) + NEW.amount / v_rate * 100,
           updated_at = now()
     WHERE id = NEW.account_id;
  ELSE
    v_spend := -NEW.amount;
    UPDATE public.wallet_accounts
       SET unbacked_cup = unbacked_cup - LEAST(unbacked_cup, v_spend),
           anchor_usd_cents = GREATEST(
             0,
             COALESCE(anchor_usd_cents, 0) - (v_spend - LEAST(unbacked_cup, v_spend)) / v_rate * 100
           ),
           updated_at = now()
     WHERE id = NEW.account_id;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) process_recharge_refund: reverse at the recharge's original USD worth.
CREATE OR REPLACE FUNCTION public.process_recharge_refund(p_payment_intent_id uuid, p_webhook_payload jsonb DEFAULT NULL::jsonb)
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
  v_orig_usd_cents numeric;
  v_rate_today numeric;
  v_debit_cup integer;
  v_bal_before integer;
  v_metadata jsonb;
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;
  IF v_intent.status = 'refunded' THEN
    SELECT id INTO v_refund_txn_id FROM ledger_transactions
    WHERE idempotency_key = 'recharge_refund_' || p_payment_intent_id::TEXT;
    RETURN v_refund_txn_id;
  END IF;
  IF v_intent.status <> 'completed' THEN
    RAISE EXCEPTION 'Cannot refund intent in status %; expected completed', v_intent.status;
  END IF;
  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user FROM corporate_accounts WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found', v_intent.corporate_account_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSE
    v_account_user := v_intent.user_id;
    IF v_intent.recharge_type IN ('tricicoin', 'driver_quota') THEN
      v_account_type := 'tricicoin';
    ELSE
      v_account_type := 'customer_cash';
    END IF;
  END IF;
  SELECT id INTO v_account_id FROM wallet_accounts
  WHERE user_id = v_account_user AND account_type = v_account_type::wallet_account_type;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Wallet account not found';
  END IF;

  v_idempotency_key := 'recharge_refund_' || p_payment_intent_id::TEXT;
  SELECT id INTO v_refund_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_refund_txn_id IS NOT NULL THEN
    UPDATE payment_intents SET status = 'refunded',
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      updated_at = NOW() WHERE id = p_payment_intent_id;
    RETURN v_refund_txn_id;
  END IF;

  -- Tema D: reverse at the recharge's ORIGINAL USD worth, not today's rate. The daily
  -- revaluation already grew the balance to anchor*rate, so debiting that current worth
  -- and removing exactly the original USD from the anchor leaves both consistent.
  v_orig_usd_cents := COALESCE(v_intent.amount_usd * 100,
                               v_intent.amount_cup / NULLIF(v_intent.exchange_rate, 0) * 100);
  v_metadata := jsonb_build_object(
    'payment_provider', v_intent.payment_provider,
    'provider_intent_id', v_intent.stripe_payment_intent_id,
    'refund_amount_cup', v_intent.amount_cup,
    'refund_amount_usd', v_intent.amount_usd,
    'corporate_account_id', v_intent.corporate_account_id,
    'webhook_payload', p_webhook_payload
  );

  IF v_orig_usd_cents IS NOT NULL AND v_orig_usd_cents > 0 THEN
    v_rate_today := public.get_current_exchange_rate();
    v_debit_cup  := ROUND(v_orig_usd_cents / 100.0 * v_rate_today)::int;
    v_metadata := v_metadata || jsonb_build_object(
      'refund_debited_cup', v_debit_cup,
      'refund_original_usd_cents', v_orig_usd_cents,
      'anchor_directives', jsonb_build_array(jsonb_build_object(
        'account_id', v_account_id,
        'anchor_usd_cents_delta', -v_orig_usd_cents
      ))
    );
  ELSE
    -- Legacy intent without USD/rate: keep the old behavior (debit original CUP, let
    -- the trigger recompute the anchor).
    v_debit_cup := v_intent.amount_cup;
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key, 'refund', 'posted', 'payment_intent', p_payment_intent_id,
    'Refund of wallet recharge: -' || v_debit_cup || ' CUP (~-$' || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    v_metadata,
    v_intent.user_id
  ) RETURNING id INTO v_refund_txn_id;

  SELECT balance INTO v_bal_before FROM wallet_accounts WHERE id = v_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_refund_txn_id, v_account_id, -v_debit_cup, v_bal_before - v_debit_cup);
  UPDATE wallet_accounts SET balance = balance - v_debit_cup, updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE payment_intents SET status = 'refunded',
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    updated_at = NOW() WHERE id = p_payment_intent_id;
  RETURN v_refund_txn_id;
END;
$function$;
