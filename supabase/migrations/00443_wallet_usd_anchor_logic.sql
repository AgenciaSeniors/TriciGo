-- 00443_wallet_usd_anchor_logic.sql
--
-- Part 2 of the USD-anchored prepaid wallet feature (enums + column in 00442).
--
-- Anchors customer_cash / corporate_cash balances in USD. The ledger stays in
-- CUP (money engine untouched). Each anchored wallet stores anchor_usd_cents
-- (its USD value). A daily cron revalues the CUP balance to keep that USD value
-- as ElToque moves, writing a double-entry `fx_revaluation` ledger transaction
-- (user wallet +/- delta, platform_fx_reserve -/+ delta). Symmetric (up & down).
--
-- Audit contract: every change to an anchored balance is a ledger movement.
-- The anchor itself is maintained by a trigger on ledger_entries, so no money
-- RPC (recharge / complete_ride_and_pay / gift / admin) is modified.

-- ─────────────────────────────────────────────────────────────────────────
-- 1) Platform FX reserve wallet (double-entry contra account).
--    Owned by the platform system user (same owner as platform_revenue).
-- ─────────────────────────────────────────────────────────────────────────
SELECT public.ensure_wallet_account(
  '00000000-0000-0000-0000-000000000001'::uuid,
  'platform_fx_reserve'::public.wallet_account_type
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2) Maintain anchor_usd_cents on every real movement of an anchored wallet.
--    Captures recharge / ride / gift / admin in ONE place (no RPC changes).
--    Skips fx_revaluation entries (they realign CUP to the anchor at the new
--    rate — they do NOT change the wallet's USD value).
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
BEGIN
  SELECT account_type INTO v_type FROM public.wallet_accounts WHERE id = NEW.account_id;
  IF v_type IS NULL OR v_type NOT IN ('customer_cash', 'corporate_cash') THEN
    RETURN NEW;
  END IF;

  SELECT type INTO v_txn_type FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  IF v_txn_type = 'fx_revaluation' THEN
    RETURN NEW;  -- realignment, not a change in USD value
  END IF;

  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NEW;  -- can't convert; leave anchor untouched (rare)
  END IF;

  UPDATE public.wallet_accounts
     SET anchor_usd_cents = COALESCE(anchor_usd_cents, 0) + ROUND(NEW.amount / v_rate * 100)::int,
         updated_at = now()
   WHERE id = NEW.account_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_maintain_usd_anchor ON public.ledger_entries;
CREATE TRIGGER trg_ledger_maintain_usd_anchor
  AFTER INSERT ON public.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_ledger_maintain_usd_anchor();

-- ─────────────────────────────────────────────────────────────────────────
-- 3) Daily revaluation: realign CUP balance to anchor_usd_cents at the current
--    rate, writing an auditable double-entry fx_revaluation per adjusted wallet.
--    Symmetric (delta can be negative). Idempotent per wallet per UTC day.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revalue_anchored_wallets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
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
     WHERE account_type IN ('customer_cash', 'corporate_cash')
       AND anchor_usd_cents IS NOT NULL
     ORDER BY id
  LOOP
    v_target := ROUND(r.anchor_usd_cents / 100.0 * v_rate)::int;
    v_delta  := v_target - r.balance;
    CONTINUE WHEN v_delta = 0;

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
       jsonb_build_object('rate', v_rate, 'anchor_usd_cents', r.anchor_usd_cents, 'delta_cup', v_delta),
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
  '00443 Daily: realigns anchored prepaid wallet CUP balances to anchor_usd_cents * current_rate, writing fx_revaluation double-entry movements (contra = platform_fx_reserve). Symmetric, idempotent per wallet per UTC day.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4) Backfill anchor for existing prepaid wallets. METADATA ONLY — does not
--    change any balance, so no ledger entry is created. Idempotent (only NULL).
-- ─────────────────────────────────────────────────────────────────────────
DO $backfill$
DECLARE v_rate numeric;
BEGIN
  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN v_rate := 520; END IF;

  UPDATE public.wallet_accounts
     SET anchor_usd_cents = ROUND(balance / v_rate * 100)::int
   WHERE account_type IN ('customer_cash', 'corporate_cash')
     AND anchor_usd_cents IS NULL;
END $backfill$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5) Schedule the daily revaluation (04:30 UTC). Idempotent re-schedule.
-- ─────────────────────────────────────────────────────────────────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'revalue-anchored-wallets') THEN
    PERFORM cron.unschedule('revalue-anchored-wallets');
  END IF;
  PERFORM cron.schedule(
    'revalue-anchored-wallets',
    '30 4 * * *',
    'SELECT public.revalue_anchored_wallets();'
  );
END $cron$;
