-- ============================================================
-- 00623 — drop the dead "quota_grace_trips" config row
--
-- The admin page Settings → Platform config lists every row of
-- platform_config, so the "Viajes de gracia" option only goes away
-- when its row does.
--
-- Nothing live reads it. The only reader in prod is
-- deduct_driver_quota(), which has had no caller (function or trigger)
-- since the single-wallet consolidation (00300), and which neither anon
-- nor authenticated can execute. The admin button that granted grace
-- trips was removed in #1089 for the same reason. If that function were
-- ever called again, its grace limit would read as NULL.
--
-- The function, admin_grant_grace_trips() and the
-- driver_profiles.grace_trips_remaining column stay (UI-only removal).
--
-- tg_platform_config_audit records the DELETE in admin_actions.
-- ============================================================

DELETE FROM public.platform_config WHERE key = 'quota_grace_trips';

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_config WHERE key = 'quota_grace_trips') THEN
    RAISE EXCEPTION '00623: quota_grace_trips is still in platform_config';
  END IF;
END
$assert$;
