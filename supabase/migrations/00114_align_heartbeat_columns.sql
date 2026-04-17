-- ============================================================
-- Migration 00114: Align driver heartbeat columns
-- F604-columns: Migration 00081 created last_heartbeat_at, migration 00107
-- created last_heartbeat. Two columns for the same purpose — the RPC writes
-- to last_heartbeat but eligible_drivers view and accept_ride RPC read
-- last_heartbeat_at. This causes stale driver detection to malfunction.
-- Canonical column: last_heartbeat_at (used by view, accept_ride, mobile apps).
-- ============================================================

-- Fix: driver_heartbeat RPC writes to canonical column
CREATE OR REPLACE FUNCTION driver_heartbeat(p_driver_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE driver_profiles
  SET last_heartbeat_at = NOW()
  WHERE id = p_driver_id;
$$;

-- Fix: mark_stale_drivers_offline reads canonical column
CREATE OR REPLACE FUNCTION mark_stale_drivers_offline(p_stale_threshold_minutes INTEGER DEFAULT 3)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE driver_profiles
  SET is_online = false
  WHERE is_online = true
    AND last_heartbeat_at < NOW() - (p_stale_threshold_minutes || ' minutes')::INTERVAL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Copy any newer timestamps from last_heartbeat to last_heartbeat_at (idempotent)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'driver_profiles'
      AND column_name = 'last_heartbeat'
  ) THEN
    UPDATE driver_profiles
    SET last_heartbeat_at = last_heartbeat
    WHERE last_heartbeat IS NOT NULL
      AND (last_heartbeat_at IS NULL OR last_heartbeat > last_heartbeat_at);
  END IF;
END $$;

-- Drop redundant column and index
DROP INDEX IF EXISTS idx_driver_profiles_heartbeat;
ALTER TABLE driver_profiles DROP COLUMN IF EXISTS last_heartbeat;
