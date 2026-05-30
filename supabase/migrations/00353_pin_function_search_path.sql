-- ============================================================
-- Migration 00353: pin search_path on app-owned functions
--
-- Advisor lint 0011 (function_search_path_mutable): 47 of our own
-- SECURITY DEFINER / helper functions had a role-mutable search_path,
-- which (for SECURITY DEFINER ones especially) is a privilege-escalation
-- vector — a role able to create objects in an earlier schema could
-- shadow an unqualified reference.
--
-- This pins a stable search_path on every public function that (a) lacks
-- one and (b) is NOT owned by an extension (PostGIS / pg_trgm / http /
-- unaccent / pg_net contribute ~775 functions in `public` that we must
-- not touch — they are managed by their extensions). The value matches
-- the project's established hardened pattern and keeps unqualified
-- references to extension objects (pg_trgm, postgis, unaccent — installed
-- in public/extensions) resolving exactly as before.
--
-- Idempotent: a re-run finds nothing left to alter.
-- ============================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      -- only functions that don't already pin a search_path
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
        WHERE c LIKE 'search_path=%'
      )
      -- skip extension-owned functions (PostGIS, pg_trgm, http, unaccent, ...)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_catalog', r.sig);
  END LOOP;
END $$;
