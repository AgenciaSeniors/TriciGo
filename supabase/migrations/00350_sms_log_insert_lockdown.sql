-- ============================================================
-- Migration 00350: lock down sms_log INSERT
--
-- Advisor lint 0024 (permissive RLS policy): sms_log had an INSERT policy
-- `sms_log_service_insert` with `WITH CHECK (true)`, so any anon /
-- authenticated client could write arbitrary rows. sms_log stores phone
-- numbers + message bodies (PII), so this allowed log poisoning / PII
-- injection and audit-trail pollution.
--
-- The only legitimate writer is the `send-sms` Edge Function, which uses
-- the service_role key and bypasses RLS — it needs no client INSERT
-- policy. We drop the permissive policy and revoke the client INSERT
-- grant. SELECT stays admin-only via the existing sms_log_admin_select.
-- ============================================================

DROP POLICY IF EXISTS sms_log_service_insert ON public.sms_log;

REVOKE INSERT ON public.sms_log FROM anon, authenticated;
