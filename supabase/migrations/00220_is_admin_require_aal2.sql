-- ============================================================
-- BUG-196 P1: enforce MFA on admin operations.
--
-- Problem: 0 of 4 admin/super_admin users have MFA enrolled. Any
-- compromise of an admin's primary auth (OTP-via-WhatsApp + email
-- session) gives full access to is_admin()-gated RPCs (wallet
-- adjustments, dispute refunds, redemptions, fraud resolution, all
-- the admin reports, platform_config edits...).
--
-- Fix: is_admin() now also requires the JWT's `aal` claim to be
-- 'aal2' (Authenticator Assurance Level 2 — proven via TOTP/WebAuthn
-- on top of the primary factor).
--
-- ⚠️ DO NOT APPLY THIS MIGRATION until ALL admin/super_admin users
--   have enrolled an MFA factor. Otherwise admins lose access to
--   the /admin panel and to admin-only RPCs.
--
-- Enrollment procedure (per-admin, ~2 minutes):
--   1. Log into the admin panel as today.
--   2. Open Supabase Dashboard → Account → Multi-factor Auth.
--      (or use supabase.auth.mfa.enroll() in app code if exposed.)
--   3. Scan QR with Google Authenticator / 1Password / Authy.
--   4. Verify the 6-digit code.
--   5. Save the recovery code somewhere safe.
--
-- Verification before applying:
--   SELECT u.email, mf.factor_type, mf.status
--   FROM users u
--   LEFT JOIN auth.mfa_factors mf ON mf.user_id = u.id AND mf.status='verified'
--   WHERE u.role IN ('admin','super_admin');
--   -- Expect every row to have a verified factor.
--
-- Rollback (if it locks out admins):
--   CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
--     LANGUAGE sql STABLE AS $$
--       SELECT current_user_role() IN ('admin','super_admin');
--   $$;
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    current_user_role() IN ('admin', 'super_admin')
    AND COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'BUG-196: requires both admin/super_admin role AND aal2 JWT claim. '
  'Admins must enrol an MFA factor and complete the second-factor challenge '
  'on each session before any is_admin()-gated RPC will accept their call.';
