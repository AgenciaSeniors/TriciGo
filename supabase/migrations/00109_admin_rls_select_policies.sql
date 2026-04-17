-- ============================================================
-- Migration 00109: Admin RLS SELECT policies
-- BUG-QA004: Admin panel shows empty tables because RLS
-- policies only allow users to see their own data.
-- Admin users (is_admin()) need SELECT access to all rows.
-- ============================================================

DO $$ BEGIN
  -- driver_profiles
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='driver_profiles'::regclass AND polname='dp_admin_select') THEN
    CREATE POLICY dp_admin_select ON driver_profiles FOR SELECT USING (is_admin());
  END IF;
  -- users
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='users'::regclass AND polname='users_admin_select') THEN
    CREATE POLICY users_admin_select ON users FOR SELECT USING (is_admin());
  END IF;
  -- rides
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='rides'::regclass AND polname='r_admin_select') THEN
    CREATE POLICY r_admin_select ON rides FOR SELECT USING (is_admin());
  END IF;
  -- vehicles
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='vehicles'::regclass AND polname='v_admin_select') THEN
    CREATE POLICY v_admin_select ON vehicles FOR SELECT USING (is_admin());
  END IF;
  -- support_tickets
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='support_tickets'::regclass AND polname='st_admin_select') THEN
    CREATE POLICY st_admin_select ON support_tickets FOR SELECT USING (is_admin());
  END IF;
  -- ride_disputes
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='ride_disputes'::regclass AND polname='rd_admin_select') THEN
    CREATE POLICY rd_admin_select ON ride_disputes FOR SELECT USING (is_admin());
  END IF;
  -- reviews
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='reviews'::regclass AND polname='rev_admin_select') THEN
    CREATE POLICY rev_admin_select ON reviews FOR SELECT USING (is_admin());
  END IF;
  -- driver_documents
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='driver_documents'::regclass AND polname='dd_admin_select') THEN
    CREATE POLICY dd_admin_select ON driver_documents FOR SELECT USING (is_admin());
  END IF;
  -- incident_reports
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='incident_reports'::regclass AND polname='ir_admin_select') THEN
    CREATE POLICY ir_admin_select ON incident_reports FOR SELECT USING (is_admin());
  END IF;
END $$;
