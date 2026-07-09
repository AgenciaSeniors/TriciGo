-- 00491: allow admins to INSERT driver_documents rows.
--
-- Context: admins can upload a driver's document on the driver's behalf from the
-- admin panel (drivers/[id]) when the driver can't upload it themselves (poor
-- connectivity in Cuba). The Storage write goes through the `storage-upload`
-- Edge Function (service-role, already admin-authorized), but the client then
-- INSERTs the `driver_documents` metadata row via PostgREST — and the existing
-- INSERT policy `dd_insert` only allows the OWNING driver
-- (driver_id IN driver_profiles of auth.uid()). So the admin upload succeeded in
-- Storage but failed the DB insert with
-- "new row violates row-level security policy for table driver_documents".
--
-- Fix: add a parallel INSERT policy for admins, symmetric with the table's
-- existing `dd_admin_select` (SELECT) and `dd_update` (UPDATE is_admin()) policies
-- which already trust is_admin(). Multiple PERMISSIVE INSERT policies are OR-ed,
-- so the driver's own `dd_insert` path is unaffected.
DROP POLICY IF EXISTS dd_admin_insert ON public.driver_documents;
CREATE POLICY dd_admin_insert ON public.driver_documents
  FOR INSERT
  WITH CHECK (is_admin());
