-- ============================================================
-- BUG-112: `lost_items` had RLS enabled but ZERO policies, which is
-- Postgres's "deny all to anon/authenticated" fallback. The whole
-- lost-and-found feature was unreachable via the normal client path —
-- `apps/admin/src/app/lost-found/*`, the lost-item.service.ts service
-- layer, and the client `/ride/lost-item/[rideId]` screen all use
-- `.from('lost_items')` which silently returned zero rows (or blocked
-- inserts) for every authenticated user.
--
-- Audited at fix time: 0 rows in `lost_items`, meaning the feature
-- had never worked end-to-end in production.
--
-- Policy model:
--   - Reporter (customer of the ride) can INSERT + SELECT + UPDATE
--     their own reports (all lifecycle transitions until resolved).
--   - Driver of the ride can SELECT the report and UPDATE their
--     response fields (driver_response / driver_found).
--   - Admins can do everything via is_admin() (accepts both 'admin'
--     and 'super_admin' roles).
-- ============================================================

DROP POLICY IF EXISTS lost_items_reporter_all ON public.lost_items;
CREATE POLICY lost_items_reporter_all
  ON public.lost_items
  FOR ALL
  USING (reporter_id = auth.uid())
  WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS lost_items_driver_read ON public.lost_items;
CREATE POLICY lost_items_driver_read
  ON public.lost_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles dp
      WHERE dp.id = lost_items.driver_id AND dp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS lost_items_driver_update ON public.lost_items;
CREATE POLICY lost_items_driver_update
  ON public.lost_items
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles dp
      WHERE dp.id = lost_items.driver_id AND dp.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM driver_profiles dp
      WHERE dp.id = lost_items.driver_id AND dp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS lost_items_admin_all ON public.lost_items;
CREATE POLICY lost_items_admin_all
  ON public.lost_items
  FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());
