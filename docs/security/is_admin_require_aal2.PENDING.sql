-- ============================================================
-- PENDING (do NOT auto-apply): require MFA (AAL2) for admin actions
--
-- This file is intentionally OUTSIDE supabase/migrations/ so that
-- `supabase db push` / the deploy pipeline does NOT apply it
-- automatically. Applying it before every admin has enrolled a TOTP
-- authenticator would lock all admins out of admin tools, because
-- is_admin() is used by admin RPCs and RLS policies across the app.
--
-- ROLLOUT (coordinated):
--   1. TOTP enrolment is already enabled (supabase/config.toml
--      [auth.mfa.totp]). Confirm it is also ON in the Supabase dashboard
--      (Authentication > Multi-Factor) for the live project.
--   2. Have EVERY admin / super_admin enrol an authenticator app and sign
--      in with it at least once (so their session reaches aal2). Verify:
--        SELECT u.id, u.role
--        FROM users u
--        WHERE u.role IN ('admin','super_admin')
--          AND NOT EXISTS (
--            SELECT 1 FROM auth.mfa_factors f
--            WHERE f.user_id = u.id AND f.status = 'verified');
--      This must return ZERO rows before proceeding.
--   3. Copy this file into supabase/migrations/ with the next free number
--      (e.g. 00352_is_admin_require_aal2.sql) and apply it.
--
-- Effect: is_admin() returns true only when the caller's role is admin AND
-- the session is MFA-elevated (aal2). Also pins a stable search_path
-- (fixes the function_search_path_mutable advisory finding for is_admin).
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path = public, pg_catalog
AS $function$
  SELECT current_user_role() IN ('admin', 'super_admin')
     AND COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$function$;
