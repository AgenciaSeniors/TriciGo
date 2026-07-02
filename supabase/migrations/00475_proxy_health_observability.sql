-- ============================================================
-- 00475_proxy_health_observability.sql
--
-- Track 1 (observabilidad) + Track 4b (redundancia) del proxy de pagos NETOPIA.
--
--  (a) Seeds the platform_config keys the proxy-health EF writes and the admin
--      reads, so they exist (jsonb NOT NULL) before the EF's UPDATE path runs
--      and are visible in /settings/platform-config.
--  (b) Seeds the OPTIONAL fallback-proxy host/port keys (Track 4b) — empty by
--      default (no fallback) until a 2nd CONNECT proxy is provisioned.
--  (c) Schedules a synthetic np-proxy probe every 5 min via pg_cron, INDEPENDENT
--      of the VPS box (the VPS-local watchdog can't self-report if the whole box
--      is down; this edge-side probe still alerts). It POSTs proxy-health?probe=1
--      with the service_role key; the EF fetches https://tricigo.com/np-proxy/
--      and records/alerts on transition.
--
-- Idempotent: ON CONFLICT DO NOTHING for the seeds; cron.schedule() upserts by
-- job name.
-- Reverse: SELECT cron.unschedule('probe-netopia-proxy-health');
--          DELETE FROM platform_config WHERE key LIKE 'netopia_proxy_health%'
--            OR key IN ('netopia_proxy_anomaly','netopia_proxy_host_fallback','netopia_proxy_port_fallback');
-- ============================================================

-- (a) health state keys (written by the proxy-health EF)
INSERT INTO platform_config (key, value) VALUES
  ('netopia_proxy_health',        '"unknown"'::jsonb),
  ('netopia_proxy_health_at',     'null'::jsonb),
  ('netopia_proxy_health_detail', 'null'::jsonb),
  ('netopia_proxy_anomaly',       'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- (b) Track 4b — optional fallback CONNECT proxy (empty = none, app skips it)
INSERT INTO platform_config (key, value) VALUES
  ('netopia_proxy_host_fallback', '""'::jsonb),
  ('netopia_proxy_port_fallback', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- (c) edge-side synthetic probe every 5 min
SELECT cron.schedule(
  'probe-netopia-proxy-health', '*/5 * * * *',
  $$SELECT net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/proxy-health?probe=1',
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer '||get_service_role_key(),
        'apikey', get_service_role_key()),
      body := '{}'::jsonb);$$
);
