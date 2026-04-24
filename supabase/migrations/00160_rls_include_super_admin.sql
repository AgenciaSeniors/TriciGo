-- ============================================================
-- BUG-100: two RLS policies restricted access to `users.role = 'admin'`
-- but production uses `super_admin` for elevated accounts. As a result,
-- super_admins could not SELECT/INSERT/UPDATE on campaigns or
-- validation_events from the admin panel, and the /campaigns page
-- silently showed "Sin campañas" even when rows existed.
--
-- Discovered while seeding E2E verification data: a row inserted via
-- service_role was invisible to an authenticated super_admin viewing
-- /campaigns.
--
-- Fix: widen each policy to accept IN ('admin', 'super_admin').
-- ============================================================

DROP POLICY IF EXISTS "Admin full access on campaigns" ON public.campaigns;
CREATE POLICY "Admin full access on campaigns"
  ON public.campaigns
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('admin'::user_role, 'super_admin'::user_role)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('admin'::user_role, 'super_admin'::user_role)
    )
  );

DROP POLICY IF EXISTS admins_read_all ON public.validation_events;
CREATE POLICY admins_read_all
  ON public.validation_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('admin'::user_role, 'super_admin'::user_role)
    )
  );
