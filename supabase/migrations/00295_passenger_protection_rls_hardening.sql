-- ============================================================
-- DRV-006 + DRV-007 + DRV-008 (security audit 2026-05-23, Driver
-- privacy & passenger protection):
--
-- Three RLS gaps that together enable driver-side stalking and
-- abuse against passengers. Fixed in one migration because they
-- share the same defensive pattern (filter on rides.status to
-- limit access to the active-trip window).
--
-- ─── DRV-006: tips RLS doesn't validate ride membership ───────
--
-- Current policy on `tips`:
--   "Users can create tips" FOR INSERT WITH CHECK (from_user_id = auth.uid())
--
-- This validates that the caller is who they claim to be (from_user_id),
-- but does NOT validate that the caller is the customer of the ride
-- being tipped on, nor that the to_driver_id is the driver of that
-- ride. So any authenticated user can:
--
--   INSERT INTO tips (ride_id, from_user_id, to_driver_id, amount)
--   VALUES (
--     'random-ride-of-other-customer',  -- no ownership check
--     auth.uid(),
--     'driver-id-victim',               -- or complice for self-tip
--     50000
--   );
--
-- The most concerning vectors:
--   1. Driver A coordinates with a secondary customer account to
--      self-tip arbitrary amounts (transfer of value bypassing
--      legitimate tip flow).
--   2. Manipulation of driver rating / leaderboard signals that
--      depend on tip count or volume.
--   3. If wallet-debit on tip insert (verify in tips trigger),
--      from_user_id's wallet drained without consent of the
--      legitimate ride customer.
--
-- Fix: rewrite "Users can create tips" with JOIN to rides
-- validating that (a) caller is the customer of the ride and
-- (b) the ride is in a tip-eligible status (completed or
-- in_progress — pre-completion tips OK for delivery, post-
-- completion for ride finalization).
--
-- ─── DRV-007: ride_location_events accessible post-completion ──
--
-- Current policy on `ride_location_events`:
--   "rl_select" FOR SELECT USING (
--     ride_id IN (SELECT id FROM rides WHERE customer_id=auth.uid()
--                  OR driver_id IN (SELECT id FROM driver_profiles
--                                   WHERE user_id=auth.uid()))
--     OR is_admin()
--   )
--
-- No status filter. Driver completes ride with customer C on day 1.
-- Days/months later, the driver can:
--
--   SELECT lat, lng, recorded_at FROM ride_location_events
--   WHERE ride_id = 'old-ride-with-customer-C';
--
-- and reconstruct the customer's GPS trace from the trip (every
-- N seconds). Combined with the driver's own history visibility,
-- this lets the driver infer the customer's home / work / weekend
-- patterns — a real-world stalking enabler that escalates to
-- physical risk.
--
-- Fix: gate the SELECT to active-trip statuses only. Customer
-- post-completion access (to look up their own old trips) is
-- preserved by keeping `customer_id = auth.uid()` as the
-- alternative branch.
--
-- ─── DRV-008: ride_messages accessible post-completion ────────
--
-- Same shape as DRV-007 on `ride_messages`:
--   "rm_select" FOR SELECT USING (
--     (caller is customer OR driver of the ride) OR is_admin()
--   )
--
-- Driver retains read access to chat history indefinitely. If the
-- customer shared sensitive info in chat (alternate phone, home
-- address details for delivery, medical context for safety), the
-- driver retains that forever.
--
-- Fix: same status filter as DRV-007 — limit driver-side reads to
-- active-trip window. Customer-side reads preserved across all
-- statuses (customer should be able to consult their own past
-- chat history for support / disputes).
--
-- ─── Active-trip status set ───────────────────────────────────
--
-- Both DRV-007 and DRV-008 use the same status set:
--   'accepted', 'driver_en_route', 'arrived_at_pickup',
--   'in_progress', 'arrived_at_destination', 'disputed'
--
-- 'disputed' included so admins and disputants can still access
-- the location/message history during dispute resolution. The
-- moment dispute resolves to 'completed', driver access drops.
-- 'completed' / 'canceled' / 'no_show' / etc. block driver-side
-- access by default; customer always retains access to own data.
--
-- ─── Admin bypass ──────────────────────────────────────────────
--
-- All three policies preserve `is_admin()` bypass — admin tooling
-- needs unrestricted access for support, forensics, dispute
-- resolution, etc.
-- ============================================================

-- ── DRV-006: tips RLS with ride-membership validation ──

DROP POLICY IF EXISTS "Users can create tips" ON public.tips;

CREATE POLICY "Users can create tips on own rides" ON public.tips
  FOR INSERT
  WITH CHECK (
    from_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.rides r
      WHERE r.id = tips.ride_id
        AND r.customer_id = auth.uid()
        AND r.status IN ('in_progress', 'arrived_at_destination', 'completed', 'disputed')
        AND (
          -- The driver of this ride must match the tipped driver
          tips.to_driver_id IN (
            SELECT dp.user_id FROM public.driver_profiles dp
            WHERE dp.id = r.driver_id
          )
        )
    )
  );

COMMENT ON POLICY "Users can create tips on own rides" ON public.tips IS
  'DRV-006: validates caller is the customer of the ride AND the tipped driver is the assigned driver of that ride. Ride must be in tip-eligible status (in_progress / arrived_at_destination / completed / disputed). Closes the self-tip via secondary account vector + driver/rating manipulation.';

-- ── DRV-007: ride_location_events — active-trip window only for driver ──

DROP POLICY IF EXISTS rl_select ON public.ride_location_events;

CREATE POLICY rl_select ON public.ride_location_events
  FOR SELECT
  USING (
    -- Admin bypass
    is_admin()
    OR
    -- Customer of the ride: always (even post-completion, for own history)
    ride_id IN (
      SELECT id FROM public.rides
      WHERE customer_id = (SELECT auth.uid())
    )
    OR
    -- Driver of the ride: only during active-trip window
    ride_id IN (
      SELECT r.id FROM public.rides r
      WHERE r.driver_id IN (
        SELECT dp.id FROM public.driver_profiles dp
        WHERE dp.user_id = (SELECT auth.uid())
      )
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup',
                         'in_progress', 'arrived_at_destination', 'disputed')
    )
  );

COMMENT ON POLICY rl_select ON public.ride_location_events IS
  'DRV-007: customer retains read access to own ride GPS history; driver-side read access limited to active-trip statuses (closes stalking via post-completion GPS reconstruction). Admin bypass preserved.';

-- ── DRV-008: ride_messages — same active-trip window for driver ──

DROP POLICY IF EXISTS rm_select ON public.ride_messages;

CREATE POLICY rm_select ON public.ride_messages
  FOR SELECT
  USING (
    is_admin()
    OR
    -- Customer of the ride: always (own chat history)
    ride_id IN (
      SELECT id FROM public.rides
      WHERE customer_id = (SELECT auth.uid())
    )
    OR
    -- Driver of the ride: only during active-trip window
    ride_id IN (
      SELECT r.id FROM public.rides r
      JOIN public.driver_profiles dp ON r.driver_id = dp.id
      WHERE dp.user_id = (SELECT auth.uid())
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup',
                         'in_progress', 'arrived_at_destination', 'disputed')
    )
  );

COMMENT ON POLICY rm_select ON public.ride_messages IS
  'DRV-008: customer retains read access to own chat history; driver-side access limited to active-trip statuses (closes information retention vector for customer-shared PII in chat). Admin bypass preserved.';
