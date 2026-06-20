-- 00446_wallet_anchor_unbacked_split.sql
-- Pre-launch audit 2026-06-20 — AUD-005 (full model) + AUD-015 (dead-band) + AUD-017 (locks)
-- + rounding/negative-anchor hardening from adversarial review.
--
-- The USD-anchored wallet (00441-00444) revalues an anchored wallet's CUP balance so its USD
-- value is preserved as ElToque moves. But the anchor was incremented by EVERY credit, including
-- platform-minted promo/referral credits that brought NO USD in, so that unbacked CUP was being
-- revalued upward on every rate move (AUD-005 giveaway). The audit's quick "skip the credit's
-- anchor" fix is WRONG: revalue sets balance = ROUND(anchor/100*rate) ABSOLUTELY, so skipping the
-- credit would DESTROY the promo balance at the next revaluation.
--
-- Correct model: split each anchored wallet into a USD-backed portion (anchor_usd_cents, floats
-- with the rate) and an unbacked portion (new unbacked_cup, held flat 1:1). Grounded against prod:
-- promo_credit is the single ledger type that credits unbacked value (admin_reward_referral,
-- trg_referral_reward_on_*, admin_send_gift). User P2P gifts use transfer_in (real conserved value
-- → backed). ride_hold/ride_hold_release have no emitter.
--
-- Adversarial review hardening:
--  * anchor_usd_cents becomes NUMERIC so per-entry maintenance carries NO integer-cents rounding
--    (rounding happens once, at revaluation). This removes the flat-rate false-revaluation that an
--    integer anchor produced from accumulated ROUND bias.
--  * The backed-debit subtraction is clamped at 0 (GREATEST) so an intraday rate change between a
--    credit and a later debit can never push the anchor negative → no money creation at revalue.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Unbacked portion + full-precision anchor.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.wallet_accounts
  ADD COLUMN IF NOT EXISTS unbacked_cup integer NOT NULL DEFAULT 0;

-- Only tg_ledger_maintain_usd_anchor + revalue_anchored_wallets read anchor_usd_cents (verified);
-- the wallet service coerces it back to a number for the "valor protegido" display.
ALTER TABLE public.wallet_accounts
  ALTER COLUMN anchor_usd_cents TYPE numeric USING anchor_usd_cents::numeric;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Maintain trigger: promo_credit -> unbacked_cup; other credits -> anchor;
--    debits spend unbacked first, then backed (clamped at 0). Skip realignments
--    and the dead hold types.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_ledger_maintain_usd_anchor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_type     public.wallet_account_type;
  v_txn_type public.ledger_entry_type;
  v_rate     numeric;
  v_spend    integer;
BEGIN
  SELECT account_type INTO v_type FROM public.wallet_accounts WHERE id = NEW.account_id;
  IF v_type IS NULL OR v_type NOT IN ('customer_cash', 'corporate_cash') THEN
    RETURN NEW;
  END IF;

  SELECT type INTO v_txn_type FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  -- fx_revaluation realigns CUP to the anchor; holds are reservations (no emitter today).
  -- Neither changes the wallet's backed/unbacked composition.
  IF v_txn_type IN ('fx_revaluation', 'ride_hold', 'ride_hold_release') THEN
    RETURN NEW;
  END IF;

  IF NEW.amount = 0 THEN RETURN NEW; END IF;

  -- promo_credit = platform-minted, no USD inflow (referral / promo / admin gift). Route the
  -- whole amount (credit or clawback) to the unbacked portion, never the USD anchor, so the
  -- revaluation holds it flat. Clamp at 0; a clawback beyond the unbacked balance is forgiven
  -- (never confiscated from the backed anchor) and logged for reconciliation visibility.
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
    RETURN NEW;  -- can't convert; leave anchor untouched (rare)
  END IF;

  IF NEW.amount > 0 THEN
    -- backed credit (recharge / refund / transfer_in / quota_recharge / admin +).
    -- Numeric anchor → no per-entry rounding.
    UPDATE public.wallet_accounts
       SET anchor_usd_cents = COALESCE(anchor_usd_cents, 0) + NEW.amount / v_rate * 100,
           updated_at = now()
     WHERE id = NEW.account_id;
  ELSE
    -- debit (spend): consume the unbacked portion first, then the backed portion. Both SET
    -- expressions read the same pre-update unbacked_cup, so the split is atomic & consistent.
    -- Clamp the backed anchor at 0 so an intraday rate change can't drive it negative.
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
$$;
-- Trigger trg_ledger_maintain_usd_anchor (00443) already wired AFTER INSERT ON ledger_entries.

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Revaluation: target = backed (ROUND(anchor*rate)) + unbacked (flat).
--    AUD-015 dead-band; AUD-017 FOR UPDATE on reserve + each wallet.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revalue_anchored_wallets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rate       numeric;
  v_fx_account uuid;
  v_fx_balance integer;
  r            RECORD;
  v_bal        integer;
  v_anchor     numeric;
  v_unbacked   integer;
  v_target     integer;
  v_delta      integer;
  v_txn_id     uuid;
  v_key        text;
  v_count      integer := 0;
  v_platform   uuid := '00000000-0000-0000-0000-000000000001';
  c_deadband   constant integer := 1;  -- AUD-015 (numeric anchor → flat days are exact 0)
BEGIN
  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE WARNING 'revalue_anchored_wallets: no exchange rate; skipping';
    RETURN 0;
  END IF;

  SELECT id, balance INTO v_fx_account, v_fx_balance
    FROM public.wallet_accounts WHERE account_type = 'platform_fx_reserve' LIMIT 1
    FOR UPDATE;
  IF v_fx_account IS NULL THEN
    RAISE WARNING 'revalue_anchored_wallets: platform_fx_reserve missing; skipping';
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id FROM public.wallet_accounts
     WHERE account_type IN ('customer_cash', 'corporate_cash')
       AND anchor_usd_cents IS NOT NULL
     ORDER BY id
  LOOP
    SELECT balance, GREATEST(0, anchor_usd_cents), COALESCE(unbacked_cup, 0)
      INTO v_bal, v_anchor, v_unbacked
      FROM public.wallet_accounts WHERE id = r.id
      FOR UPDATE;

    v_target := ROUND(v_anchor / 100.0 * v_rate)::int + v_unbacked;
    v_delta  := v_target - v_bal;
    CONTINUE WHEN abs(v_delta) <= c_deadband;  -- AUD-015: no churn from a single-ROUND boundary

    -- one revaluation per wallet per UTC day
    v_key := 'fx_reval:' || r.id::text || ':' || to_char((now() AT TIME ZONE 'UTC'), 'YYYYMMDD');
    IF EXISTS (SELECT 1 FROM public.ledger_transactions WHERE idempotency_key = v_key) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.ledger_transactions
      (idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by)
    VALUES
      (v_key, 'fx_revaluation', 'posted', 'wallet_account', r.id,
       'Ajuste por tipo de cambio (ancla USD)',
       jsonb_build_object('rate', v_rate, 'anchor_usd_cents', v_anchor, 'unbacked_cup', v_unbacked, 'delta_cup', v_delta),
       v_platform)
    RETURNING id INTO v_txn_id;

    -- user wallet leg
    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, r.id, v_delta, v_target);
    UPDATE public.wallet_accounts SET balance = v_target, updated_at = now() WHERE id = r.id;

    -- platform contra leg (opposite sign)
    v_fx_balance := v_fx_balance - v_delta;
    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_fx_account, -v_delta, v_fx_balance);
    UPDATE public.wallet_accounts SET balance = v_fx_balance, updated_at = now() WHERE id = v_fx_account;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.revalue_anchored_wallets() IS
  '00446 Daily: floats the USD-backed portion of anchored wallets (anchor_usd_cents * rate) and holds the unbacked (promo/referral) portion flat. Numeric anchor (no per-entry rounding); dead-band + FOR UPDATE locks on the reserve + each wallet.';
