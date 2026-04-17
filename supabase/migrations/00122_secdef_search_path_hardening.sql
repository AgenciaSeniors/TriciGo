-- ============================================================
-- Migration 00122: Harden SECURITY DEFINER functions with SET search_path
--
-- PostgreSQL security best practice: every SECURITY DEFINER function
-- should set its own search_path to prevent search_path hijacking
-- attacks. Without this, a caller can create shadow objects (e.g.
-- `pg_temp.function_i_call`) that execute with definer privileges.
--
-- Applied via dynamic DO block so new functions get picked up without
-- enumerating every signature manually. Excludes PostGIS wrappers
-- (st_*) since those are extension-owned.
-- ============================================================

DO $outer$
DECLARE
  r record;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef = true
      AND n.nspname = 'public'
      AND p.proname NOT LIKE 'st\_%'
      AND (p.proconfig IS NULL
           OR NOT ('search_path=public, pg_catalog' = ANY(p.proconfig)))
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = public, pg_catalog',
      r.sig
    );
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Hardened % SECURITY DEFINER functions', v_count;
END
$outer$;
