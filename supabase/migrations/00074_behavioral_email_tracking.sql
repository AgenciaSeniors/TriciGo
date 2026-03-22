-- 00074: Behavioral email tracking
-- Creates email_sends table to track sent emails and avoid duplicates.
-- Schedules daily behavioral-emails edge function via pg_cron.

-- ── Table: email_sends ──
CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  template TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_email_sends_user_template ON email_sends(user_id, template);
CREATE INDEX idx_email_sends_sent_at ON email_sends(sent_at);

ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

-- Service role only — no user-facing policies
-- (All access goes through the behavioral-emails edge function with service_role key)

-- ── Cron job: run behavioral-emails daily at 8:00 AM UTC ──
SELECT cron.schedule(
  'behavioral-emails-daily',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/behavioral-emails',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id;
  $$
);
