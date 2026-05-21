-- ============================================================
-- Migration 00273: Remove driver cashout / redemption feature
--
-- The driver cashout/redemption flow let drivers convert their
-- TriciCoin balance into off-platform cash payouts. That made the
-- driver TriciCoin balance an OPEN loop. Removing it makes TriciCoin
-- genuinely closed-loop: driver balance can only be earned and spent
-- inside the platform, never cashed out.
--
-- Safety: public.wallet_redemptions verified EMPTY (0 rows) in
-- production before this removal — dropping the table loses no data.
--
-- Removes:
--   - wallet_redemptions table (+ its indexes, RLS policies wr_select/
--     wr_insert/wr_admin, and the wallet_redemptions_amount_positive
--     CHECK constraint from 00189) via DROP TABLE ... CASCADE
--   - approve_redemption(uuid, uuid) RPC (from 00189)
--   - redemption_status enum (00001)
--   - platform_config keys driving auto-approval of redemptions
--   - the wallet_redemptions dependency inside get_admin_wallet_stats
--
-- NOT touched:
--   - ledger_entry_type enum keeps its 'redemption' value — historical
--     ledger rows posted by past approvals still reference it.
-- ============================================================

-- Step 1: drop the redemptions table.
-- CASCADE also drops its dependent objects: the RLS policies
-- (wr_select, wr_insert, wr_admin), the CHECK constraint
-- wallet_redemptions_amount_positive, and any indexes / FK refs.
DROP TABLE IF EXISTS public.wallet_redemptions CASCADE;

-- Step 2: drop the atomic approval RPC (created in
-- 00189_wallet_redemption_atomic_approve.sql with signature
-- approve_redemption(p_redemption_id uuid, p_admin_id uuid)).
DROP FUNCTION IF EXISTS public.approve_redemption(uuid, uuid);

-- Step 3: drop the redemption_status enum — no remaining table or
-- function references it once the table and RPC are gone.
DROP TYPE IF EXISTS public.redemption_status;

-- Step 4: remove the auto-admin config keys that drove automatic
-- approval of redemptions. The auto-admin edge function no longer
-- reads these.
DELETE FROM platform_config
WHERE key IN (
  'auto_approve_redemptions_enabled',
  'auto_approve_redemptions_max_trc'
);

-- Step 5: rewrite get_admin_wallet_stats so it no longer queries
-- wallet_redemptions (which no longer exists). The RETURNS TABLE
-- signature is kept IDENTICAL so existing callers (admin.service.ts
-- adminService.getWalletStats) and generated types stay valid;
-- pending_redemptions_count / pending_redemptions_amount are simply
-- hardcoded to 0 now that redemptions no longer exist.
CREATE OR REPLACE FUNCTION get_admin_wallet_stats()
RETURNS TABLE(
  total_in_circulation BIGINT,
  pending_redemptions_count BIGINT,
  pending_redemptions_amount BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(balance), 0) FROM wallet_accounts
     WHERE is_active = true)
      AS total_in_circulation,
    -- Cashout/redemption feature removed (migration 00273): there are
    -- no pending redemptions anymore. Hardcoded to 0 to preserve the
    -- function signature for existing callers.
    0::BIGINT AS pending_redemptions_count,
    0::BIGINT AS pending_redemptions_amount;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
