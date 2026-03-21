-- SEC-3: Remove OR status = 'searching' from driver ride select policy
-- This was exposing all searching rides (with customer locations) to any authenticated user
DROP POLICY IF EXISTS "r_select_driver" ON rides;
CREATE POLICY "r_select_driver" ON rides FOR SELECT
USING (
  driver_id IN (SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid()))
);

-- SEC-2: Ensure drivers can only update their own profile (including location)
DROP POLICY IF EXISTS "dp_update_own" ON driver_profiles;
CREATE POLICY "dp_update_own" ON driver_profiles FOR UPDATE
USING (user_id = (SELECT auth.uid()) OR is_admin());
