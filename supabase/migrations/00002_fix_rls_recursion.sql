-- Fix RLS recursion: current_user_role() queries `users` table,
-- but `users` RLS policy calls is_admin() → current_user_role() → infinite loop.
-- Solution: make current_user_role() SECURITY DEFINER so it bypasses RLS.

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS user_role AS $$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
