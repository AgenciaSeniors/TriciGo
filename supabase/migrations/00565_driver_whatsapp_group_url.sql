-- ============================================================
-- 00565_driver_whatsapp_group_url.sql
--
-- Seeds the `driver_whatsapp_group_url` platform_config key so the
-- admin settings page (settings/platform-config) renders it — that page
-- only lists keys that already exist as rows in platform_config.
--
-- Value is a jsonb string (same convention as netopia_environment /
-- driver_latest_version). Empty placeholder: the operator pastes the
-- WhatsApp group invite link (https://chat.whatsapp.com/<code>) from the
-- admin panel. While empty, the driver app hides the "join group" UI
-- (frontend tolerance) — so this migration is safe to ship before the
-- link exists.
--
-- Editable only by super_admin (platform_config write policies gated on
-- is_super_admin() since 00292).
-- ============================================================

INSERT INTO platform_config (key, value) VALUES
  ('driver_whatsapp_group_url', '""')
ON CONFLICT (key) DO NOTHING;
