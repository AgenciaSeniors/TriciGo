-- 00508: allow admins to INSERT driver_documents rows.
--        DRIFT FIX — the policy already exists in prod; this brings it into git.
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
-- Fix: a parallel INSERT policy for admins, symmetric with the table's existing
-- `dd_admin_select` (SELECT is_admin()) and `dd_update` (UPDATE is_admin())
-- policies, which already trust is_admin(). Multiple PERMISSIVE INSERT policies
-- are OR-ed, so the driver's own `dd_insert` path is unaffected.
--
-- ── Why this is a re-number of PR #781 ──────────────────────────────────────
-- #781 shipped this as 00491, which collides with 00491_campaigns_promo_code_
-- on_delete_set_null.sql on master. Supabase keys schema_migrations by the full
-- filename so both would apply, but the numbering convention breaks and the
-- history becomes ambiguous (see CLAUDE.md "Pre-flight para elegir número").
-- Content is unchanged apart from this header.
--
-- ── Verified against prod before writing ────────────────────────────────────
--   * dd_admin_insert EXISTS with WITH CHECK (is_admin())  → applied out-of-band
--   * NO migration on master creates it                    → git/prod drift
--   * is_admin() = current_user_role() IN ('admin','super_admin'), the same gate
--     dd_admin_select and dd_update already use → no new privilege
--   * trg_driver_documents_validate_mime still fires on admin INSERTs, so this
--     does NOT let an admin bypass MIME validation
--   * RLS is enabled on the table; there is still no DELETE policy (unchanged)
--
-- Idempotent: DROP IF EXISTS + CREATE. Applying to prod is a no-op.

DROP POLICY IF EXISTS dd_admin_insert ON public.driver_documents;
CREATE POLICY dd_admin_insert ON public.driver_documents
  FOR INSERT
  WITH CHECK (is_admin());
