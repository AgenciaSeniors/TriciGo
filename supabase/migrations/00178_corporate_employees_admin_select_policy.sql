-- ============================================================
-- BUG-121: corporate_employees had INSERT/UPDATE/DELETE policies for
-- corp admins (corp_admin_insert/update/delete) and platform admins,
-- but the only SELECT policy was `corporate_employees_self_read`
-- (user_id = auth.uid()). Effect:
--   - apps/client/app/profile/corporate.tsx → corporateService.getEmployees
--   - apps/admin/src/app/businesses/[id]/page.tsx → same RPC
-- both returned ONLY the calling user's own row, hiding the rest of
-- the team. The "manage employees" UI was effectively broken: corp
-- admins could add new employees but couldn't see the resulting list.
--
-- Verified by simulating SET LOCAL "request.jwt.claims" with a corp
-- admin's UUID and selecting from corporate_employees → only 1 row
-- (self) returned out of 3 active rows.
--
-- Fix: add a SELECT policy that covers the same actors as the existing
-- INSERT/UPDATE/DELETE policies — corp admin of the same account, OR
-- platform admin/super_admin. Self-read policy is kept so plain
-- employees can still see their own membership.
--
-- NOTE: this initial version triggers infinite recursion (the EXISTS
-- subquery on corporate_employees re-fires the same SELECT policy).
-- Migration 00179 replaces this with a SECURITY DEFINER helper.
-- Both migrations stay in history so the timeline is auditable.
-- ============================================================

CREATE POLICY corporate_employees_corp_admin_read
  ON public.corporate_employees
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM corporate_employees ce
      WHERE ce.corporate_account_id = corporate_employees.corporate_account_id
        AND ce.user_id = auth.uid()
        AND ce.role = 'admin'
        AND ce.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('admin', 'super_admin')
    )
  );

COMMENT ON POLICY corporate_employees_corp_admin_read ON public.corporate_employees IS
  'BUG-121 (initial): replaced in 00179 — self-referential EXISTS triggers infinite recursion in PostgreSQL RLS.';
