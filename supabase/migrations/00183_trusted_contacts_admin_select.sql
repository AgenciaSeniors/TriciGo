-- ============================================================
-- BUG-126: trusted_contacts had policies for the contact owner
-- (Users can {view,insert,update,delete} own contacts) and the
-- service_role, but NO admin policy. Effect:
--   - Platform admin/super_admin investigating an SOS event in
--     /admin/safety couldn't see who would have been notified.
--   - The incident_reports row already exposes the SOS event
--     to admins (ir_admin policy), so this is just the directory
--     of contacts that surrounds it. Without it, "who got the
--     SMS?" becomes a blind spot in the post-incident review.
--
-- Fix: add ir_admin_select-equivalent policy. Read-only — admins
-- shouldn't be editing a user's emergency contacts list directly.
-- ============================================================

CREATE POLICY tc_admin_select
  ON public.trusted_contacts
  FOR SELECT
  TO authenticated
  USING (is_admin());

COMMENT ON POLICY tc_admin_select ON public.trusted_contacts IS
  'BUG-126: admins can read trusted_contacts to investigate SOS events. Read-only — admins should not modify a user''s emergency directory.';
