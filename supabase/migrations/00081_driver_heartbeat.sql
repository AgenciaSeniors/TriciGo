-- Add break mode column if missing (from migration 00075)
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS is_on_break BOOLEAN NOT NULL DEFAULT false;

-- Add heartbeat column for zombie driver detection
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz DEFAULT now();

-- Index for efficient heartbeat queries
CREATE INDEX IF NOT EXISTS idx_driver_heartbeat ON driver_profiles(last_heartbeat_at) WHERE is_online = true;

-- V2.1: View for matching-eligible drivers (heartbeat < 3 min)
CREATE OR REPLACE VIEW public.eligible_drivers AS
  SELECT * FROM driver_profiles
  WHERE is_online = true
    AND (is_on_break IS NULL OR is_on_break = false)
    AND (is_financially_eligible IS NULL OR is_financially_eligible = true)
    AND last_heartbeat_at > now() - interval '3 minutes';

-- Backup cron: auto-offline drivers with stale heartbeat (>10 min)
-- Only create if pg_cron extension exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'auto-offline-stale-drivers',
      '*/5 * * * *',
      'UPDATE driver_profiles SET is_online = false WHERE is_online = true AND last_heartbeat_at < now() - interval ''10 minutes'''
    );
  END IF;
END $$;
