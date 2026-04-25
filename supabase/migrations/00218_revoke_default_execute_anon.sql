-- ============================================================
-- BUG-200: the Supabase factory-default privileges in `public`
-- grant EXECUTE on every newly-created function to anon and
-- authenticated. This is the root cause of most of the SECDEF
-- exposure bugs found across Tiers 6-12 (every new SECDEF was
-- exposed to anon by default — see BUG-160, 166, 170-178, 183,
-- 187-189, 195, etc.).
--
-- Fix: revoke the default. Future migrations must explicitly
-- `GRANT EXECUTE ON FUNCTION ... TO authenticated` if they want
-- the function callable by the app.
--
-- Tables and sequences are left at the Supabase default — they
-- rely on RLS for protection, and changing the default would
-- require adding explicit GRANT to every new table migration
-- (massive workflow disruption for marginal extra protection,
-- since RLS already handles access).
--
-- This change does NOT affect existing functions; only future
-- ones. For existing function exposure issues see the targeted
-- REVOKEs in earlier migrations (00208, 00211, 00212, 00216).
-- ============================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Note: supabase_admin's default privileges (PostGIS, etc.) are not
-- modifiable via service_role MCP. Tightening those defaults requires
-- the platform owner (postgres superuser) and is a follow-up.
