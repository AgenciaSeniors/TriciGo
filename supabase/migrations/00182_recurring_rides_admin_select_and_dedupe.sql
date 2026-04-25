-- ============================================================
-- BUG-125: recurring_rides had two issues:
--   1. Eight policies covering only owner access (4 named
--      `recurring_rides_owner_*` + 4 named `rr_*`, two copies of
--      the same logic). Functionally OK but Postgres evaluates
--      both sets on every query, and the duplication is a
--      hidden tripwire for any future policy change.
--   2. NO admin policy. Platform admin/super_admin couldn't read
--      a customer's recurring rides to investigate a support
--      ticket, even though admins read every other customer
--      table (rides, wallet_accounts, customer_profiles via
--      is_admin()). When the admin team later wires up a
--      "Customer support → recurring rides" panel, the queries
--      will silently return empty.
--
-- Fix: drop the four legacy `recurring_rides_owner_*` policies
-- (same effect as the rr_* set). Add `rr_admin_select` so admins
-- can read for support.
-- ============================================================

DROP POLICY IF EXISTS recurring_rides_owner_select ON public.recurring_rides;
DROP POLICY IF EXISTS recurring_rides_owner_insert ON public.recurring_rides;
DROP POLICY IF EXISTS recurring_rides_owner_update ON public.recurring_rides;
DROP POLICY IF EXISTS recurring_rides_owner_delete ON public.recurring_rides;

CREATE POLICY rr_admin_select
  ON public.recurring_rides
  FOR SELECT
  TO authenticated
  USING (is_admin());

COMMENT ON POLICY rr_admin_select ON public.recurring_rides IS
  'BUG-125: lets platform admin/super_admin read recurring rides for support, matching the access they already have on rides, wallet_accounts and customer_profiles.';
