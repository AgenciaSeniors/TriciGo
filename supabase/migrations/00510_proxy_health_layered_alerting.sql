-- ============================================================
-- 00510_proxy_health_layered_alerting.sql
--
-- Proxy-health v2 (de-flap): per-LAYER health state + time-debounced alerts.
--
-- Why: v1 kept ONE state key (netopia_proxy_health) written by two reporters
-- with different scopes (vps-watchdog probes squid+npproxy; edge-probe probes
-- npproxy only). A squid-only incident made them disagree → the shared state
-- flapped ok<->down every ~2 min → 10 alert emails for ONE incident
-- (2026-07-20, a NETOPIA-side edge stall — the VPS was healthy the whole
-- time). Single-probe blips also emailed immediately (2026-07-21, NETOPIA
-- answered 502 on /pay/ for ~1 request → 2 emails each).
--
-- v2 (EF supabase/functions/proxy-health + ops/squid/healthcheck.sh):
--   • Per-layer keys, each with a single writer (no more flapping):
--       netopia_proxy_health_squid / _npproxy   ← vps-watchdog
--       netopia_proxy_health_edge               ← edge-probe (pg_cron)
--     each with _since (episode start) + _alerted (down email already sent).
--   • netopia_proxy_health stays as the worst-of rollup (back-compat for the
--     docs/queries that read it).
--   • Alert email only after netopia_proxy_alert_after_s of CONTINUOUS non-ok
--     (default 600 s ≈ 3 probe cycles); recovery email only if the down alert
--     was actually sent.
--   • States: ok | down (the VPS service is broken → restart/ssh useful)
--     | upstream (NETOPIA itself failing, verified by direct-from-VPS control
--     probes → do NOT touch the VPS) | config (/np-proxy/ 403 = x-proxy-secret
--     drift).
--   • The watchdog no longer auto-restarts squid/nginx on 'upstream'/'config'
--     failures (only on real 'down', 2 consecutive strikes).
--
-- The EF creates/updates all keys at runtime via upsert; this seed documents
-- them and sets the tunable's default so it shows up in the admin
-- /settings/platform-config page. Idempotent (ON CONFLICT DO NOTHING).
-- Reverse:
--   DELETE FROM platform_config WHERE key = 'netopia_proxy_alert_after_s'
--     OR key LIKE 'netopia_proxy_health\_squid%'
--     OR key LIKE 'netopia_proxy_health\_npproxy%'
--     OR key LIKE 'netopia_proxy_health\_edge%'
--     OR key = 'netopia_proxy_watchdog_last_at';
-- ============================================================

INSERT INTO platform_config (key, value) VALUES
  ('netopia_proxy_alert_after_s',          '"600"'::jsonb),
  ('netopia_proxy_health_squid',           '"unknown"'::jsonb),
  ('netopia_proxy_health_squid_since',     '""'::jsonb),
  ('netopia_proxy_health_squid_alerted',   '"false"'::jsonb),
  ('netopia_proxy_health_npproxy',         '"unknown"'::jsonb),
  ('netopia_proxy_health_npproxy_since',   '""'::jsonb),
  ('netopia_proxy_health_npproxy_alerted', '"false"'::jsonb),
  ('netopia_proxy_health_edge',            '"unknown"'::jsonb),
  ('netopia_proxy_health_edge_since',      '""'::jsonb),
  ('netopia_proxy_health_edge_alerted',    '"false"'::jsonb),
  ('netopia_proxy_watchdog_last_at',       '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
