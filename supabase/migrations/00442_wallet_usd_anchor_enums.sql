-- 00442_wallet_usd_anchor_enums.sql
--
-- Part 1 of the USD-anchored prepaid wallet feature (see 00443 for the logic).
-- Split in two migrations because Postgres forbids USING a freshly added enum
-- value in the same transaction that adds it (same pattern as the Tier feature
-- 00370/00371). This migration ONLY adds the enum values + the anchor column;
-- it does not use them. 00443 (separate transaction) creates the wallet,
-- trigger, RPC, backfill and cron that reference them.
--
-- WHY: ride prices are already USD-anchored (00441) so the rider's CUP floats
-- with ElToque. But the prepaid wallet balance (customer_cash / corporate_cash)
-- is still pure CUP, so it devalues like cash. We anchor those balances in USD:
-- the rider keeps seeing CUP, but a daily revaluation keeps the CUP equal to
-- anchor_usd_cents/100 * rate, writing a double-entry `fx_revaluation` ledger
-- transaction for every adjustment (audit-complete; no money appears unbacked).

-- New platform account that absorbs the FX revaluation (double-entry contra).
ALTER TYPE public.wallet_account_type ADD VALUE IF NOT EXISTS 'platform_fx_reserve';

-- New ledger entry type for the revaluation movements.
ALTER TYPE public.ledger_entry_type ADD VALUE IF NOT EXISTS 'fx_revaluation';

-- USD anchor (cents). Source of truth for the wallet's USD value; the CUP
-- `balance` is revalued to match anchor_usd_cents/100 * current_rate.
ALTER TABLE public.wallet_accounts
  ADD COLUMN IF NOT EXISTS anchor_usd_cents integer;

COMMENT ON COLUMN public.wallet_accounts.anchor_usd_cents IS
  '00442 USD anchor (cents) for prepaid wallets (customer_cash/corporate_cash). The CUP balance is revalued daily to ROUND(anchor_usd_cents/100 * rate); each adjustment is a fx_revaluation ledger entry. NULL = not anchored.';
