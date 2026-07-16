-- 00499_app_latest_version_config.sql
--
-- In-app "update available" prompt (client + driver apps).
--
-- On app open, the mobile apps compare their installed version
-- (Constants.expoConfig.version) against these keys and, when outdated,
-- show a dismissible bottom sheet linking to Play Store / App Store
-- (UpdateAvailableSheet in each app).
--
-- OPERATION: after publishing a new release in the stores, the admin
-- updates the matching key from Settings → Platform Config. Keep the
-- value in step with the store rollout — Play releases are gradual, so
-- bump the key once the release is broadly available.
--
-- Values are jsonb strings (same convention as netopia_environment).
-- Seeded with the version shipping at the time of this migration; apps
-- ignore the prompt when their version >= the key (or the key is absent).

INSERT INTO platform_config (key, value) VALUES
  ('client_latest_version', '"1.1.0"'),
  ('driver_latest_version', '"1.1.0"')
ON CONFLICT (key) DO NOTHING;
