-- ============================================================
-- Migration 00107: Driver heartbeat + stale driver detection
-- F604: Drivers that close the app stay is_online=true forever.
-- Add last_heartbeat column + function to mark stale drivers offline.
-- ============================================================

-- Add heartbeat timestamp to driver_profiles
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ DEFAULT NOW();

-- Index for finding stale drivers efficiently
CREATE INDEX IF NOT EXISTS idx_driver_profiles_heartbeat
  ON driver_profiles (last_heartbeat)
  WHERE is_online = true;

-- RPC: Update driver heartbeat (called every 60s by driver app)
CREATE OR REPLACE FUNCTION driver_heartbeat(p_driver_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE driver_profiles
  SET last_heartbeat = NOW()
  WHERE id = p_driver_id;
$$;

-- RPC: Mark stale drivers as offline (called by pg_cron every 2 min)
CREATE OR REPLACE FUNCTION mark_stale_drivers_offline(p_stale_threshold_minutes INTEGER DEFAULT 3)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE driver_profiles
  SET is_online = false
  WHERE is_online = true
    AND last_heartbeat < NOW() - (p_stale_threshold_minutes || ' minutes')::INTERVAL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
