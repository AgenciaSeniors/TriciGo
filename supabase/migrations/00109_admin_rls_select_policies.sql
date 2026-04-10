-- ============================================================
-- Migration 00109: Admin RLS SELECT policies
-- BUG-QA004: Admin panel shows empty tables because RLS
-- policies only allow users to see their own data.
-- Admin users need SELECT access to all rows.
-- ============================================================

-- driver_profiles: admin can see all
CREATE POLICY IF NOT EXISTS dp_admin_select ON driver_profiles
  FOR SELECT USING (is_admin());

-- users: admin can see all
CREATE POLICY IF NOT EXISTS users_admin_select ON users
  FOR SELECT USING (is_admin());

-- rides: admin can see all
CREATE POLICY IF NOT EXISTS r_admin_select ON rides
  FOR SELECT USING (is_admin());
