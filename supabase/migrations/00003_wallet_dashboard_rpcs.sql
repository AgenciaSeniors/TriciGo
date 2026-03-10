-- ============================================================
-- Migration 00003: Wallet & Dashboard RPCs
-- Creates server-side functions for wallet summary,
-- admin dashboard metrics, and admin wallet stats.
-- All SECURITY DEFINER to bypass RLS.
-- ============================================================

-- 1. Wallet summary for a user (called by walletService.getSummary)
CREATE OR REPLACE FUNCTION get_wallet_summary(p_user_id UUID)
RETURNS TABLE(
  available_balance INTEGER,
  held_balance INTEGER,
  total_earned INTEGER,
  total_spent INTEGER,
  currency TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(wa.balance, 0)::INTEGER AS available_balance,
    COALESCE(wa.held_balance, 0)::INTEGER AS held_balance,
    0::INTEGER AS total_earned,
    0::INTEGER AS total_spent,
    'TRC'::TEXT AS currency
  FROM wallet_accounts wa
  WHERE wa.user_id = p_user_id
    AND wa.account_type = 'customer_cash'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::INTEGER, 0::INTEGER, 0::INTEGER, 0::INTEGER, 'TRC'::TEXT;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 2. Admin dashboard metrics (called by adminService.getDashboardMetrics)
CREATE OR REPLACE FUNCTION get_admin_dashboard_metrics()
RETURNS TABLE(
  active_rides BIGINT,
  total_rides_today BIGINT,
  online_drivers BIGINT,
  total_revenue_today BIGINT,
  pending_verifications BIGINT,
  open_incidents BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM rides
     WHERE status IN ('searching','accepted','driver_en_route','arrived_at_pickup','in_progress'))
      AS active_rides,
    (SELECT COUNT(*) FROM rides
     WHERE created_at >= CURRENT_DATE)
      AS total_rides_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE is_online = true)
      AS online_drivers,
    (SELECT COALESCE(SUM(final_fare_cup), 0) FROM rides
     WHERE status = 'completed' AND completed_at >= CURRENT_DATE)
      AS total_revenue_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE status IN ('pending_verification','under_review'))
      AS pending_verifications,
    (SELECT COUNT(*) FROM incident_reports
     WHERE status IN ('open','investigating'))
      AS open_incidents;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- 3. Admin wallet stats (called by adminService.getWalletStats)
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
    (SELECT COUNT(*) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_count,
    (SELECT COALESCE(SUM(amount), 0) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_amount;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
