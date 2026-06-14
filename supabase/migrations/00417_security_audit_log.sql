-- 00417_security_audit_log.sql
-- ============================================================================
-- The EF↔DB contract sweep (2026-06-13) found that two auth Edge Functions —
-- request-password-reset and add-email-with-verification — write/read
-- `audit_log` with columns action/actor_id/target_id/details that DO NOT EXIST
-- (public.audit_log is the generic change-audit table: changed_by/operation/
-- record_id/table_name/old_values/new_values, written by a trigger).
--
-- Two consequences:
--   1) Both EFs' fire-and-forget audit inserts (wrapped in .then(()=>{},()=>{}))
--      silently failed -> the security audit trail for password-reset and
--      email-change attempts was never written.
--   2) request-password-reset's ONLY per-identifier rate limit counted
--      audit_log rows by `action`/`details->>identifier`; that query errored on
--      the missing columns, `count` came back null, and `0 >= 3` was always
--      false, so the "3 / hour per identifier" limit NEVER triggered. The SMS
--      path is still covered by send-sms-otp's own per-phone limit (BUG-186),
--      but the EMAIL path had no other guard -> recovery-email bombing of a
--      victim was possible.
--
-- The rate-limit bug is fixed in the EF itself (it now uses the shared
-- check_rate_limit-backed limiter). This migration restores the INTENDED audit
-- trail with a proper append-only table the EFs repoint to, so password-reset /
-- email-change attempts are recorded for account-takeover forensics & abuse
-- detection. Append-only, admin-read; service-role (the EFs) bypasses RLS to
-- INSERT; no client write path.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.security_audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action     text NOT NULL,
  actor_id   uuid,
  target_id  uuid,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_audit_log_action_created_idx
  ON public.security_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_log_actor_idx
  ON public.security_audit_log (actor_id, created_at DESC);

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

-- Admin-only read. Service-role (the auth Edge Functions) bypasses RLS for the
-- INSERTs; there is intentionally no INSERT/UPDATE/DELETE policy, so no client
-- (anon/authenticated) can write or tamper with the trail.
DROP POLICY IF EXISTS security_audit_log_admin_select ON public.security_audit_log;
CREATE POLICY security_audit_log_admin_select ON public.security_audit_log
  FOR SELECT USING (is_admin());

COMMENT ON TABLE public.security_audit_log IS
  'Append-only security events (password_reset_requested, email_change_requested, …) written by auth Edge Functions via service-role. Admin-read only. Added 00417.';
