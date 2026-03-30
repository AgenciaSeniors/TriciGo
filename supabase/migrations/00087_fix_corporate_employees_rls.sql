-- ============================================================
-- Fix: corporate_employees RLS infinite recursion on SELECT
--
-- The corporate_employees_corp_admin policy was FOR ALL with a
-- self-referencing EXISTS subquery. On SELECT this caused
-- infinite recursion (500 error). Split into INSERT/UPDATE/DELETE
-- policies so SELECT only uses corporate_employees_self_read.
-- ============================================================

-- Drop the problematic ALL policy
DROP POLICY IF EXISTS corporate_employees_corp_admin ON corporate_employees;

-- Re-create for INSERT only
CREATE POLICY corporate_employees_corp_admin_insert ON corporate_employees
  FOR INSERT TO authenticated
  WITH CHECK (
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

-- Re-create for UPDATE only
CREATE POLICY corporate_employees_corp_admin_update ON corporate_employees
  FOR UPDATE TO authenticated
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

-- Re-create for DELETE only
CREATE POLICY corporate_employees_corp_admin_delete ON corporate_employees
  FOR DELETE TO authenticated
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
