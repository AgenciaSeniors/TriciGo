-- ============================================================
-- Migration 00046: Ride Preferences
-- ============================================================

-- Default ride preferences on customer profiles
ALTER TABLE customer_profiles
ADD COLUMN IF NOT EXISTS ride_preferences JSONB DEFAULT '{}';

-- Snapshot of rider preferences per ride
ALTER TABLE rides
ADD COLUMN IF NOT EXISTS rider_preferences JSONB DEFAULT NULL;

-- Feature flag
INSERT INTO feature_flags (key, value, description)
VALUES ('ride_preferences_enabled', true, 'Allow riders to set trip preferences (quiet mode, temperature, etc.)')
ON CONFLICT (key) DO NOTHING;
