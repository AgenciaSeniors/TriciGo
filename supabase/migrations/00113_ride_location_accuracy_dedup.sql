-- F606: Add accuracy column to ride_location_events for GPS precision data
ALTER TABLE ride_location_events
  ADD COLUMN IF NOT EXISTS accuracy NUMERIC;

-- F006: Remove existing duplicate GPS points before adding unique constraint.
-- Keeps the row with the lowest id for each (ride_id, recorded_at) pair.
DELETE FROM ride_location_events a
  USING ride_location_events b
  WHERE a.id > b.id
    AND a.ride_id = b.ride_id
    AND a.recorded_at = b.recorded_at;

-- Add unique index to prevent duplicate GPS points from offline buffer flush
CREATE UNIQUE INDEX IF NOT EXISTS idx_ride_location_dedup
  ON ride_location_events (ride_id, recorded_at);
