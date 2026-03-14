-- ride_waypoints table (used by ride.service.ts addWaypointToActiveRide)
-- Stores intermediate stops added before or during an active ride (max 3)

CREATE TABLE IF NOT EXISTS ride_waypoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  address TEXT NOT NULL,
  arrived_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ride_waypoints_ride ON ride_waypoints(ride_id, sort_order);

-- RLS
ALTER TABLE ride_waypoints ENABLE ROW LEVEL SECURITY;

-- Rider and assigned driver can read waypoints
CREATE POLICY "waypoint_select" ON ride_waypoints FOR SELECT USING (
  ride_id IN (
    SELECT id FROM rides WHERE customer_id = auth.uid()
  )
  OR ride_id IN (
    SELECT r.id FROM rides r
    JOIN driver_profiles dp ON r.driver_id = dp.id
    WHERE dp.user_id = auth.uid()
  )
  OR is_admin()
);

-- Only the rider can add waypoints to their active ride
CREATE POLICY "waypoint_insert" ON ride_waypoints FOR INSERT WITH CHECK (
  ride_id IN (
    SELECT id FROM rides WHERE customer_id = auth.uid() AND status = 'in_progress'
  )
);

-- Enable realtime so driver gets notified of new stops
ALTER PUBLICATION supabase_realtime ADD TABLE ride_waypoints;
