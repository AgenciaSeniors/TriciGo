-- ============================================================
-- BUG-123: dp_select_own had a public clause
--   (status = 'approved' AND is_online = true)
-- that let ANY authenticated user read EVERY column of every online
-- driver — including identity_number (Cuban national ID), address,
-- province, has_criminal_record, criminal_record_details. The same
-- exposure also fired through Supabase Realtime: every driver
-- location heartbeat triggered a postgres_changes payload that
-- contained the full row, broadcast to any rider listening on
-- nearby-drivers.
--
-- Verified the leak by simulating SET LOCAL "request.jwt.claims"
-- with a regular customer's UUID and selecting identity_number,
-- address, criminal_record_details from approved+online drivers —
-- the query succeeded against three rows.
--
-- Fix:
--   1. Drop the public clause from dp_select_own. Drivers still see
--      their own row; admins still see everything.
--   2. Add count_online_drivers(within_minutes int) — SECURITY DEFINER
--      RPC for the rider home screen "N drivers nearby" badge.
--   3. Add get_assigned_driver_info(p_driver_profile_id uuid) —
--      SECURITY DEFINER RPC that returns rating + ride count when
--      the caller is the rider on an active ride with that driver.
--      ride.service.ts:716 used to read driver_profiles directly to
--      enrich the assigned-ride view; that query loses access after
--      this lockdown, so it must move to this RPC.
--
-- Realtime subscription for nearby driver positions (nearby.service.ts
-- subscribeToDriverPositions) will go silent for non-admins because
-- RLS now blocks the SELECT that gates postgres_changes. The map
-- still updates from the existing 15-second polling fallback in
-- useNearbyVehicles. A follow-up task can introduce a public
-- driver_locations table with only safe columns + trigger if the
-- product team wants the smoother live updates back.
-- ============================================================

DROP POLICY IF EXISTS dp_select_own ON public.driver_profiles;

CREATE POLICY dp_select_own
  ON public.driver_profiles
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR is_admin()
  );

COMMENT ON POLICY dp_select_own ON public.driver_profiles IS
  'BUG-123: tightened from the previous "approved AND online" public clause that exposed identity_number, address, criminal_record_details. Public access for nearby-drivers and assigned-ride views now goes through SECURITY DEFINER RPCs.';

-- Public count of online drivers for the rider home screen.
CREATE OR REPLACE FUNCTION public.count_online_drivers(p_within_minutes integer DEFAULT 5)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT COUNT(*)::integer
  FROM driver_profiles
  WHERE is_online = true
    AND last_heartbeat_at > NOW() - (p_within_minutes::text || ' minutes')::interval;
$$;

COMMENT ON FUNCTION public.count_online_drivers(integer) IS
  'BUG-123: replacement for the rider home screen count of online drivers. Returns just an integer so the public clause on dp_select_own can be removed.';

GRANT EXECUTE ON FUNCTION public.count_online_drivers(integer) TO authenticated;

-- Privacy-safe driver fields for the rider once a driver is assigned.
CREATE OR REPLACE FUNCTION public.get_assigned_driver_info(p_driver_profile_id uuid)
RETURNS TABLE (
  user_id uuid,
  rating_avg numeric,
  total_rides_completed integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    dp.user_id,
    dp.rating_avg,
    dp.total_rides_completed
  FROM driver_profiles dp
  WHERE dp.id = p_driver_profile_id
    AND (
      -- Caller is the rider with an active or recent ride with this driver.
      EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.customer_id = (SELECT auth.uid())
          AND r.created_at > NOW() - INTERVAL '24 hours'
      )
      -- The driver themselves can read it (covered by RLS too, but
      -- this RPC stays usable from the driver app without surprises).
      OR dp.user_id = (SELECT auth.uid())
      -- Platform admins.
      OR is_admin()
    );
$$;

COMMENT ON FUNCTION public.get_assigned_driver_info(uuid) IS
  'BUG-123: returns only rating + total rides for an assigned driver. Caller must be the rider on an active/recent ride with that driver, or the driver themselves, or platform admin. Replaces the previous rider-side direct SELECT on driver_profiles in ride.service.ts.';

GRANT EXECUTE ON FUNCTION public.get_assigned_driver_info(uuid) TO authenticated;
