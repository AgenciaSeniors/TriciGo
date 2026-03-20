-- 00061: Auto-admin automation config + run log table + cron job

-- ── Automation config keys ──
INSERT INTO platform_config (key, value) VALUES
  ('auto_approve_drivers_enabled', '"false"'),
  ('auto_approve_drivers_face_threshold', '"80"'),
  ('auto_approve_redemptions_enabled', '"false"'),
  ('auto_approve_redemptions_max_trc', '"10000"'),
  ('auto_resolve_fraud_enabled', '"false"'),
  ('auto_resolve_fraud_hours', '"48"'),
  ('auto_close_incidents_enabled', '"false"'),
  ('auto_close_incidents_hours', '"24"')
ON CONFLICT (key) DO NOTHING;

-- ── Auto-admin run log ──
CREATE TABLE IF NOT EXISTS auto_admin_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  drivers_approved INTEGER DEFAULT 0,
  redemptions_approved INTEGER DEFAULT 0,
  fraud_resolved INTEGER DEFAULT 0,
  incidents_closed INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auto_admin_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read_auto_runs" ON auto_admin_runs FOR SELECT USING (is_admin());

CREATE INDEX idx_auto_admin_runs_created ON auto_admin_runs (created_at DESC);

-- ── Cron: run auto-admin every 5 minutes ──
SELECT cron.schedule(
  'auto-admin',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/auto-admin',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
