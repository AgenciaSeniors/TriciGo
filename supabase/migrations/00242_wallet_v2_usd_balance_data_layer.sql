-- ============================================================
-- Wallet v2 PR 6+7 phase 1: USD-cents balance + 5% migration bonus
-- ============================================================
-- Spec: docs/WALLET_V2_USD_MODEL.md §1 (1 TC ≡ 1 USD), §6 (balance
-- migration), §10 #3 (Option C: 5% bonus for users).
--
-- This migration is the DATA LAYER ONLY. It adds USD-equivalent
-- columns alongside the existing CUP-denominated `balance` and
-- backfills them. NO code reads from these columns yet — the UI/
-- service swap is a separate follow-up PR. Existing flows
-- (deposits, ride payments, transfers, redemptions) continue to
-- read/write `balance` as before.
--
-- Why phase 1 only:
-- The unit-of-account flip touches every formatTriciCoin call site
-- (~20 surfaces across client, driver, admin, web, blog). Doing
-- the data + UI in a single PR risks an outage if any surface is
-- missed. Splitting:
--   1. (this PR) Add columns, backfill, add VIEW. Zero reads, zero
--      breakage.
--   2. (next PR) Swap formatTriciCoin to read from new columns.
--      Audit each surface.
--   3. (later) Deprecate `balance`, switch writes.
--
-- ============================================================
-- Migration rules (per spec §10 #3 + business reasoning):
-- ============================================================
--   Account type        Rule
--   ------------------- -------------------------------------------
--   customer_cash      Passenger prepaid balance.
--                       new_usd = (balance / rate) × 1.05  ← 5% bonus
--   tricicoin          Passenger TC balance (post-rebase 00094).
--                       new_usd = (balance / rate) × 1.05  ← 5% bonus
--   driver_cash        Driver earnings (NOT prepaid).
--                       new_usd = (balance / rate) × 1.00  ← 1:1, no bonus
--                       Negative balances allowed (driver debt).
--   platform_revenue   Platform's commission take. Internal accounting.
--                       new_usd = (balance / rate) × 1.00  ← 1:1, no bonus
--   platform_promotions  Platform's promo war chest. Internal.
--                       new_usd = (balance / rate) × 1.00  ← 1:1, no bonus
--   corporate_cash     Corporate prepaid balance (B2B).
--                       new_usd = (balance / rate) × 1.05  ← 5% bonus
--                       (matches passenger treatment — corporate paid for it)
--
-- Exchange rate: snapshot from `exchange_rates.usd_cup_rate` where
-- is_current=true at migration time. Reproducible (rate stamped in
-- the column comment) and auditable.
-- ============================================================

ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS balance_usd_cents       integer,
  ADD COLUMN IF NOT EXISTS held_balance_usd_cents  integer,
  ADD COLUMN IF NOT EXISTS migration_rate          numeric(10,2),
  ADD COLUMN IF NOT EXISTS migration_bonus_pct     numeric(4,2),
  ADD COLUMN IF NOT EXISTS migrated_at             timestamptz;

COMMENT ON COLUMN wallet_accounts.balance_usd_cents IS
  'Wallet v2: USD-equivalent of balance, in cents. Populated by '
  'migration 00242 using the formula (balance / migration_rate) × '
  '(1 + migration_bonus_pct/100). Existing code still reads `balance`; '
  'phase 2 PR will swap reads to this column.';

-- One-shot backfill. Re-running the migration is a no-op via the
-- WHERE migrated_at IS NULL guard.
WITH rate AS (
  SELECT usd_cup_rate FROM exchange_rates WHERE is_current = true ORDER BY created_at DESC LIMIT 1
)
UPDATE wallet_accounts wa
SET
  migration_rate = (SELECT usd_cup_rate FROM rate),
  migration_bonus_pct = CASE
    WHEN wa.account_type IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN 5.00
    ELSE 0.00
  END,
  balance_usd_cents = ROUND(
    (wa.balance::numeric / (SELECT usd_cup_rate FROM rate)) *
    CASE
      WHEN wa.account_type IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN 1.05
      ELSE 1.00
    END * 100
  )::int,
  held_balance_usd_cents = ROUND(
    (wa.held_balance::numeric / (SELECT usd_cup_rate FROM rate)) *
    CASE
      WHEN wa.account_type IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN 1.05
      ELSE 1.00
    END * 100
  )::int,
  migrated_at = now(),
  updated_at = now()
WHERE wa.migrated_at IS NULL;

-- Convenience VIEW for new code paths to read USD without joining.
-- Existing wallet_accounts reads still work — this just exposes the
-- USD-cents columns under nicer names.
CREATE OR REPLACE VIEW wallet_accounts_v2 AS
SELECT
  wa.id,
  wa.user_id,
  wa.account_type,
  wa.balance              AS balance_cup_legacy,
  wa.held_balance         AS held_balance_cup_legacy,
  wa.balance_usd_cents,
  wa.held_balance_usd_cents,
  -- numeric USD for callers that don't want to deal with cents
  ROUND(wa.balance_usd_cents::numeric / 100, 2)      AS balance_usd,
  ROUND(wa.held_balance_usd_cents::numeric / 100, 2) AS held_balance_usd,
  wa.migration_rate,
  wa.migration_bonus_pct,
  wa.migrated_at,
  wa.currency,
  wa.is_active,
  wa.is_frozen,
  wa.frozen_reason,
  wa.frozen_at,
  wa.created_at,
  wa.updated_at
FROM wallet_accounts wa;

COMMENT ON VIEW wallet_accounts_v2 IS
  'Wallet v2 view exposing USD-equivalent balances. Read-only. New '
  'code (phase 2 onwards) reads from here; legacy code keeps reading '
  'wallet_accounts.balance directly until the swap PR.';

-- Verification (run after applying):
--   SELECT account_type, count(*) AS accounts,
--          sum(balance) AS sum_cup,
--          sum(balance_usd_cents) AS sum_new_usd_cents,
--          ROUND(sum(balance_usd_cents::numeric)/100, 2) AS sum_new_usd,
--          MAX(migration_rate) AS rate, MAX(migration_bonus_pct) AS bonus_pct
--   FROM wallet_accounts
--   GROUP BY account_type
--   ORDER BY account_type;
