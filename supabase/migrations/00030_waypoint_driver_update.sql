-- Allow the assigned driver to mark waypoints as arrived/departed
CREATE POLICY "waypoint_driver_update" ON ride_waypoints FOR UPDATE USING (
  ride_id IN (
    SELECT r.id FROM rides r
    JOIN driver_profiles dp ON r.driver_id = dp.id
    WHERE dp.user_id = auth.uid() AND r.status = 'in_progress'
  )
) WITH CHECK (
  ride_id IN (
    SELECT r.id FROM rides r
    JOIN driver_profiles dp ON r.driver_id = dp.id
    WHERE dp.user_id = auth.uid() AND r.status = 'in_progress'
  )
);
