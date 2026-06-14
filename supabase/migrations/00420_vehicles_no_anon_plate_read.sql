-- 00420_vehicles_no_anon_plate_read.sql
-- ============================================================================
-- PII-01 (P1, audit 2026-06-14): the vehicles SELECT policy v_select exposes
-- EVERY active vehicle's license plate (+ make/model/color/photo/year) to the
-- ANONYMOUS public internet. Its `is_active = true` disjunct does not depend on
-- auth.uid(), and anon holds a table-level SELECT grant on public.vehicles, so an
-- unauthenticated request can scrape the whole active fleet's plates — a plate is
-- PII (traceable to an owner via Cuba's vehicle registry).
--
-- The `is_active = true` branch is load-bearing for AUTHENTICATED reads:
--   * a rider seeing their assigned driver's vehicle/plate (ride.service.ts:805,2200)
--   * the cross-fleet cargo-capability picker (useDeliveryVehicles — caps only, no PII)
-- so it cannot simply be removed. Fix: require authentication on that branch
-- (auth.uid() IS NOT NULL). This closes the anonymous/public scrape while every
-- logged-in read keeps working. Owner + admin branches unchanged.
--
-- Residual (accepted for launch): any *authenticated* user can still read active
-- vehicles' plates — far smaller surface than the public internet, and a plate is
-- visible on the street. Tightening further to ride-scoped would need column-level
-- separation of the non-PII caps from the PII plate; deferred.
-- ============================================================================

ALTER POLICY v_select ON public.vehicles
  USING (
    (driver_id IN ( SELECT driver_profiles.id
                      FROM driver_profiles
                     WHERE driver_profiles.user_id = ( SELECT auth.uid() AS uid)))
    OR (( SELECT auth.uid() AS uid) IS NOT NULL AND is_active = true)
    OR is_admin()
  );
