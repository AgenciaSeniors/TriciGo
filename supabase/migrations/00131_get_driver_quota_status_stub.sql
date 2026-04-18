-- ============================================================
-- TriciGo — get_driver_quota_status (stub)
--
-- The full driver-quota system (migration 00094) is not applied in
-- this environment — apps/driver/app/(tabs)/wallet.tsx calls
-- `walletService.getQuotaStatus(userId)` which hits this RPC. Without
-- it, every driver wallet load emits a 404.
--
-- This stub returns zero-state (no quota debit, no grace period, no
-- block). When the real quota system is enabled, replace this
-- function body with the full implementation from 00094 and add the
-- required `grace_trips_remaining`, `quota_blocked` columns on
-- driver_profiles.
-- ============================================================

CREATE OR REPLACE FUNCTION get_driver_quota_status(p_driver_user_id UUID)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'balance', 0,
    'total_recharged', 0,
    'warning_active', false,
    'grace_trips_remaining', 0,
    'blocked', false,
    'deduction_rate', COALESCE(
      (SELECT (value::TEXT)::NUMERIC FROM platform_config WHERE key='quota_deduction_rate'),
      0.15
    )
  );
$$;

GRANT EXECUTE ON FUNCTION get_driver_quota_status(UUID) TO authenticated;
