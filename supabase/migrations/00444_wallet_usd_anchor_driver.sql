-- 00444_wallet_usd_anchor_driver.sql
--
-- Extends the USD-anchored wallet feature (00442/00443) to the DRIVER wallet
-- (tricicoin), so a driver's balance keeps its USD value as the CUP devalues.
--
-- Reuses the whole engine from 00443 (anchor column, fx_revaluation entry type,
-- platform_fx_reserve contra account, the ledger trigger, the daily cron). The
-- ONLY change is widening the "anchored set" from
-- ('customer_cash','corporate_cash') to also include 'tricicoin', in the two
-- places that define it, plus a one-time anchor backfill for tricicoin wallets.
--
-- Economics: no cash-out in Cuba, so the platform holds all recharged USD;
-- tricicoin is funded by driver USD recharges + wallet-ride earnings (backed by
-- the rider's USD). So anchoring it is backed by real USD (same caveat as the
-- rider: promo/gift balances are the only unbacked part).
--
-- Both functions are reproduced VERBATIM from the live prod definitions
-- (pg_get_functiondef) with only the account-type list widened, per the
-- CREATE OR REPLACE canonical pattern (don't lose 00443 logic). The trigger and
-- cron are NOT recreated — they already point at these function names.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Anchor maintenance trigger fn — add 'tricicoin' to the anchored set.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_ledger_maintain_usd_anchor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_type     public.wallet_account_type;
  v_txn_type public.ledger_entry_type;
  v_rate     numeric;
BEGIN
  SELECT account_type INTO v_type FROM public.wallet_accounts WHERE id = NEW.account_id;
  IF v_type IS NULL OR v_type NOT IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN
    RETURN NEW;
  END IF;

  SELECT type INTO v_txn_type FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  IF v_txn_type = 'fx_revaluation' THEN
    RETURN NEW;
  END IF;

  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NEW;
  END IF;

  UPDATE public.wallet_accounts
     SET anchor_usd_cents = COALESCE(anchor_usd_cents, 0) + ROUND(NEW.amount / v_rate * 100)::int,
         updated_at = now()
   WHERE id = NEW.account_id;

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Daily revaluation fn — add 'tricicoin' to the loop's WHERE.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revalue_anchored_wallets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_rate        numeric;
  v_fx_account  uuid;
  v_fx_balance  integer;
  r             RECORD;
  v_target      integer;
  v_delta       integer;
  v_txn_id      uuid;
  v_key         text;
  v_count       integer := 0;
  v_platform    uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE WARNING 'revalue_anchored_wallets: no exchange rate; skipping';
    RETURN 0;
  END IF;

  SELECT id, balance INTO v_fx_account, v_fx_balance
    FROM public.wallet_accounts WHERE account_type = 'platform_fx_reserve' LIMIT 1;
  IF v_fx_account IS NULL THEN
    RAISE WARNING 'revalue_anchored_wallets: platform_fx_reserve missing; skipping';
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id, balance, anchor_usd_cents
      FROM public.wallet_accounts
     WHERE account_type IN ('customer_cash', 'corporate_cash', 'tricicoin')
       AND anchor_usd_cents IS NOT NULL
     ORDER BY id
  LOOP
    v_target := ROUND(r.anchor_usd_cents / 100.0 * v_rate)::int;
    v_delta  := v_target - r.balance;
    CONTINUE WHEN v_delta = 0;

    v_key := 'fx_reval:' || r.id::text || ':' || to_char((now() AT TIME ZONE 'UTC'), 'YYYYMMDD');
    IF EXISTS (SELECT 1 FROM public.ledger_transactions WHERE idempotency_key = v_key) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.ledger_transactions
      (idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by)
    VALUES
      (v_key, 'fx_revaluation', 'posted', 'wallet_account', r.id,
       'Ajuste por tipo de cambio (ancla USD)',
       jsonb_build_object('rate', v_rate, 'anchor_usd_cents', r.anchor_usd_cents, 'delta_cup', v_delta),
       v_platform)
    RETURNING id INTO v_txn_id;

    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, r.id, v_delta, v_target);
    UPDATE public.wallet_accounts SET balance = v_target, updated_at = now() WHERE id = r.id;

    v_fx_balance := v_fx_balance - v_delta;
    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_fx_account, -v_delta, v_fx_balance);
    UPDATE public.wallet_accounts SET balance = v_fx_balance, updated_at = now() WHERE id = v_fx_account;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Backfill anchor for existing tricicoin wallets. METADATA ONLY — no balance
--    change, so no ledger entry. Idempotent (only NULL anchors).
-- ─────────────────────────────────────────────────────────────────────────
DO $backfill$
DECLARE v_rate numeric;
BEGIN
  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN v_rate := 520; END IF;

  UPDATE public.wallet_accounts
     SET anchor_usd_cents = ROUND(balance / v_rate * 100)::int
   WHERE account_type = 'tricicoin'
     AND anchor_usd_cents IS NULL;
END $backfill$;
