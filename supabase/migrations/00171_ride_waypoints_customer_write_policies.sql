-- ============================================================
-- BUG-114: ride_waypoints had SELECT policy for ride participants
-- (customer + driver) and FOR ALL for admin, but NO INSERT/UPDATE/
-- DELETE policies for regular customers. The client-side createRide
-- function calls `supabase.from('ride_waypoints').insert(...)` with
-- the user's auth token, and every call was silently rejected by RLS
-- unless the user happened to be a super_admin.
--
-- Impact: the multi-stop / waypoints feature was unreachable for real
-- passengers. Only 1 waypoint row existed in prod at fix time (created
-- by Eduardo Admin via the admin policy).
--
-- Fix: allow the customer who owns the ride to INSERT/UPDATE/DELETE
-- waypoints, and allow the driver assigned to the ride to UPDATE
-- arrived_at / departed_at (for in-ride waypoint tracking).
-- ============================================================

DROP POLICY IF EXISTS ride_waypoints_customer_insert ON public.ride_waypoints;
CREATE POLICY ride_waypoints_customer_insert
  ON public.ride_waypoints
  FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid())
  );

DROP POLICY IF EXISTS ride_waypoints_customer_update ON public.ride_waypoints;
CREATE POLICY ride_waypoints_customer_update
  ON public.ride_waypoints
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid())
  );

DROP POLICY IF EXISTS ride_waypoints_customer_delete ON public.ride_waypoints;
CREATE POLICY ride_waypoints_customer_delete
  ON public.ride_waypoints
  FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid())
  );

DROP POLICY IF EXISTS ride_waypoints_driver_update ON public.ride_waypoints;
CREATE POLICY ride_waypoints_driver_update
  ON public.ride_waypoints
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM rides r
      JOIN driver_profiles dp ON dp.id = r.driver_id
      WHERE r.id = ride_waypoints.ride_id AND dp.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rides r
      JOIN driver_profiles dp ON dp.id = r.driver_id
      WHERE r.id = ride_waypoints.ride_id AND dp.user_id = auth.uid()
    )
  );
