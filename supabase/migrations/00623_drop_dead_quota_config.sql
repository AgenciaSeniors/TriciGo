-- ============================================================
-- 00623 — drop the dead driver-quota config rows
--
-- The admin page Settings → Platform config lists every row of
-- platform_config, so an option only goes away when its row does.
-- These three belong to the driver-quota model that the single-wallet
-- consolidation (00300) replaced:
--
--   quota_grace_trips            "Viajes de gracia"
--   quota_warning_threshold_pct  "Umbral de alerta de cuota baja"
--   quota_deduction_rate         "Tasa de deducción de cuota"
--
-- Who reads them in prod:
--   - deduct_driver_quota() reads all three. It has no caller (function
--     or trigger) and neither anon nor authenticated can execute it.
--   - get_driver_quota_status() reads quota_deduction_rate with
--     COALESCE(..., 0.15). The row holds 0.15, so the function returns
--     the same thing without it. No app calls it since the QuotaCard
--     was removed in #192.
-- No other function, cron job or Edge Function reads any of them
-- (complete_ride_and_pay included).
--
-- The admin button that granted grace trips was removed in #1089.
-- The functions and driver_profiles.grace_trips_remaining stay
-- (UI-only removal).
--
-- tg_platform_config_audit records each DELETE in admin_actions.
-- ============================================================

DELETE FROM public.platform_config
WHERE key IN ('quota_grace_trips', 'quota_warning_threshold_pct', 'quota_deduction_rate');

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_config
    WHERE key IN ('quota_grace_trips', 'quota_warning_threshold_pct', 'quota_deduction_rate')
  ) THEN
    RAISE EXCEPTION '00623: a dead quota key is still in platform_config';
  END IF;
END
$assert$;
