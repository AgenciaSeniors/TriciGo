-- ============================================================
-- BUG-121 (continued): the SELECT policy added in 00178 self-references
-- corporate_employees and triggers infinite recursion. Replace it with
-- a SECURITY DEFINER helper that bypasses RLS for the membership lookup.
-- This is the same pattern used by is_admin().
-- ============================================================

DROP POLICY IF EXISTS corporate_employees_corp_admin_read ON public.corporate_employees;

CREATE OR REPLACE FUNCTION public.is_corp_admin(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM corporate_employees
    WHERE corporate_account_id = p_account_id
      AND user_id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$$;

COMMENT ON FUNCTION public.is_corp_admin(uuid) IS
  'BUG-121: helper used by RLS policies on corporate_* tables to check corp-admin membership without self-recursion. SECURITY DEFINER bypasses corporate_employees RLS for the lookup.';

CREATE POLICY corporate_employees_corp_admin_read
  ON public.corporate_employees
  FOR SELECT
  TO authenticated
  USING (
    public.is_corp_admin(corporate_account_id)
    OR EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('admin', 'super_admin')
    )
  );

COMMENT ON POLICY corporate_employees_corp_admin_read ON public.corporate_employees IS
  'BUG-121: corp admins see their team; platform admins see all. Uses is_corp_admin() to avoid infinite recursion on the EXISTS lookup.';
