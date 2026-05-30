-- ============================================================
-- TriciGo — user_known_devices
--
-- Backs our own "new device login" detection, replacing GoTrue's
-- native signed_in_new_device notification (disabled in 00311 /
-- config.toml). GoTrue inferred the device from request IP/user-agent
-- — unstable for OTP login on mobile, so it flagged the same phone as
-- "new" on every sign-in. Instead the apps send a STABLE per-install
-- device_id (UUID persisted in expo-secure-store) at login; the
-- register-login-device edge function records it here and only emails
-- the user when a device_id is genuinely unseen.
--
-- Rollout safety: the FIRST device recorded for a user is silently
-- inserted (no email). Only a NEW device for a user who ALREADY has
-- >=1 known device triggers the alert — so existing users don't get a
-- blast of "new device" emails on their first post-deploy login.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_known_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  platform TEXT,
  model TEXT,
  os_version TEXT,
  app_version TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

-- Count-by-user lookups (the "does this user already have >=1 device?"
-- check) ride the UNIQUE(user_id, device_id) btree, but an explicit
-- index on user_id keeps it cheap if the unique index is ever dropped.
CREATE INDEX IF NOT EXISTS idx_user_known_devices_user
  ON user_known_devices (user_id);

ALTER TABLE user_known_devices ENABLE ROW LEVEL SECURITY;

-- Writes are done by register-login-device via the service role (which
-- bypasses RLS). Clients only ever READ their own devices (e.g. a
-- future "your devices" screen); they must not be able to forge or
-- mutate device rows, so no client INSERT/UPDATE/DELETE policy.
CREATE POLICY "ukd_select_own" ON user_known_devices
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "ukd_admin_all" ON user_known_devices
  FOR ALL USING (is_admin()) WITH CHECK (is_admin());
