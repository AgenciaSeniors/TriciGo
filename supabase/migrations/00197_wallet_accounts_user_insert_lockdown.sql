-- ============================================================
-- BUG-146: wa_insert_own had WITH CHECK (user_id = auth.uid()) but
-- no constraint on account_type or balance. A customer could call:
--
--   supabase.from('wallet_accounts').insert({
--     user_id: auth.uid(),
--     account_type: 'platform_revenue',
--     balance: 1000000,
--     currency: 'TRC',
--   });
--
-- and create a wallet with arbitrary type and balance. Verified:
-- under a customer's JWT, INSERT succeeded with account_type=
-- 'platform_revenue' and balance=1,000,000.
--
-- Direct exploit impact is limited (RLS scopes reads to own; ledger
-- invariant catches mismatch on admin review) but:
--   - The user's wallet UI may render the bogus 1M balance.
--   - Any downstream RPC that reads wallet_accounts.balance without
--     reconciling against the ledger could trust the fake number.
--   - It pollutes the wallet_invariant audit query that we lean on
--     in every regression battery.
--
-- Fix: rewrite wa_insert_own to require:
--   1. user_id = auth.uid()
--   2. account_type IN ('customer_cash','driver_cash') —
--      platform_revenue, platform_promotions, corporate_cash are
--      system accounts and must come from SECDEF helpers
--      (ensure_wallet_account) running as service_role.
--   3. balance = 0 on creation. The only way to grow a balance is
--      via ledger_entries written by admin-or-trigger paths.
--   4. held_balance = 0 likewise.
--
-- Service role / SECDEF callers (ensure_wallet_account) bypass RLS
-- entirely so seed data and platform_revenue creation still work.
-- ============================================================

DROP POLICY IF EXISTS wa_insert_own ON public.wallet_accounts;

CREATE POLICY wa_insert_own
  ON public.wallet_accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND account_type IN ('customer_cash', 'driver_cash')
    AND balance = 0
    AND COALESCE(held_balance, 0) = 0
  );

COMMENT ON POLICY wa_insert_own ON public.wallet_accounts IS
  'BUG-146: users may only create their own customer_cash or driver_cash wallets, with balance=0 and held_balance=0. Platform/corporate accounts and any non-zero balance must come from SECDEF helpers running as service_role.';
