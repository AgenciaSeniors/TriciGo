-- ============================================================================
-- Migration 00579: POI curation foundation
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §4
-- Plan: docs/superpowers/plans/2026-09-05-poi-quality-pr1-data.md (Tasks 1–5)
-- Rehearsed on a local PostGIS copy (supabase/tests/poi/) — every section is
-- idempotent and the file can be applied twice.
--
-- A. admin_create_poi / admin_update_poi / approve_poi_submission stop writing
--    the GENERATED column name_normalized (428C9 since 00309; verified in prod
--    inside BEGIN…ROLLBACK on 2026-09-05: every admin edit fails today).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. In-place patches over the LIVE bodies (pattern 00573): each target
--    literal must appear exactly once; a body that no longer mentions the
--    column is treated as already patched.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE v_src text; v_n int;
  c_t1 CONSTANT text := 'name_normalized = CASE WHEN p_name IS NOT NULL AND length(trim(p_name)) > 0
                           THEN lower(unaccent(trim(p_name))) ELSE name_normalized END,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_update_poi';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: admin_update_poi absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: admin_update_poi already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t1, ''))) / length(c_t1);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_update_poi target found % times (expected 1)', v_n; END IF;
  EXECUTE replace(v_src, c_t1, '');
  RAISE NOTICE '00579A: admin_update_poi patched';
END $patch$;

DO $patch$
DECLARE v_src text; v_n int;
  c_cols CONSTANT text := 'name, name_normalized, category, subcategory, tricigo_category,';
  c_vals CONSTANT text := 'trim(p_name), v_name_norm, ''admin'', p_tricigo_category, p_tricigo_category,';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_create_poi';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: admin_create_poi absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: admin_create_poi already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_cols, ''))) / length(c_cols);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_create_poi column target found % times', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_vals, ''))) / length(c_vals);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: admin_create_poi value target found % times', v_n; END IF;
  v_src := replace(v_src, c_cols, 'name, category, subcategory, tricigo_category,');
  v_src := replace(v_src, c_vals, 'trim(p_name), ''admin'', p_tricigo_category, p_tricigo_category,');
  EXECUTE v_src;
  RAISE NOTICE '00579A: admin_create_poi patched';
END $patch$;

DO $patch$
DECLARE v_src text; v_n int;
  c_cols CONSTANT text := 'name, name_normalized, tricigo_category, category, location,';
  c_vals CONSTANT text := 'v_submission.name,
    lower(unaccent(v_submission.name)),';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_poi_submission';
  IF v_src IS NULL THEN RAISE NOTICE '00579A: approve_poi_submission absent; skip'; RETURN; END IF;
  IF position('name_normalized' IN v_src) = 0 THEN RAISE NOTICE '00579A: approve_poi_submission already patched'; RETURN; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_cols, ''))) / length(c_cols);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: approve column target found % times', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, c_vals, ''))) / length(c_vals);
  IF v_n <> 1 THEN RAISE EXCEPTION '00579A: approve value target found % times', v_n; END IF;
  v_src := replace(v_src, c_cols, 'name, tricigo_category, category, location,');
  v_src := replace(v_src, c_vals, 'v_submission.name,');
  EXECUTE v_src;
  RAISE NOTICE '00579A: approve_poi_submission patched';
END $patch$;
