-- ============================================================
-- Migration 00309: hotfix for import_search_poi INSERT
--
-- The RPC introduced by 00308 explicitly set `name_normalized` in
-- the INSERT statement, but that column is GENERATED ALWAYS from
-- `lower(immutable_unaccent(name))` (defined post-00106, not in any
-- prior migration in the repo — likely set via Studio at some
-- point). PostgreSQL rejects INSERTs that target GENERATED
-- columns: ERROR 428C9 — "cannot insert a non-DEFAULT value into
-- column name_normalized".
--
-- Fix: drop `name_normalized` from the INSERT — the generation
-- expression will populate it automatically from `name`.
--
-- Note: the same bug exists in approve_poi_submission (00303 line
-- 266-268). That path has been untested since name_normalized
-- became GENERATED — if an admin tries to approve a submission
-- today it will fail with the same error. A follow-up fix to
-- 00303 is tracked separately; this migration only fixes the
-- 00308 RPC because that's the path PR 4b just enabled.
-- ============================================================

CREATE OR REPLACE FUNCTION public.import_search_poi(
  p_name TEXT,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_address TEXT DEFAULT NULL,
  p_tricigo_category TEXT DEFAULT 'other',
  p_mapbox_id TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_website TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_existing_id BIGINT;
  v_is_admin BOOLEAN;
  v_existing_ids JSONB;
  v_new_id BIGINT;
  v_category TEXT;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'name_too_short');
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'missing_coords');
  END IF;

  IF p_lat < 19.5 OR p_lat > 23.5 OR p_lng < -85.0 OR p_lng > -74.0 THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'out_of_cuba');
  END IF;

  v_category := CASE
    WHEN p_tricigo_category IN (
      'hospital','hotel','museum','gov','school','religion','park',
      'beach','bank','pharmacy','embassy','transport','gas_station',
      'supermarket','restaurant','paladar','cafe','bar','shop','atm'
    ) THEN p_tricigo_category
    ELSE 'other'
  END;

  v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);

  IF v_existing_id IS NOT NULL THEN
    SELECT is_admin, source_ids
      INTO v_is_admin, v_existing_ids
    FROM public.cuba_pois
    WHERE id = v_existing_id;

    IF v_is_admin THEN
      RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'admin_match');
    END IF;

    IF p_mapbox_id IS NOT NULL
       AND (v_existing_ids IS NULL OR NOT (v_existing_ids ? 'mapbox')) THEN
      UPDATE public.cuba_pois
      SET source_ids = COALESCE(source_ids, '{}'::jsonb)
                       || jsonb_build_object('mapbox', p_mapbox_id),
          updated_at = NOW()
      WHERE id = v_existing_id;
    END IF;

    RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'duplicate_within_50m');
  END IF;

  -- Note: `name_normalized` is GENERATED ALWAYS from `lower(immutable_unaccent(name))`
  -- so it is intentionally NOT in this column list. Postgres populates it itself.
  INSERT INTO public.cuba_pois (
    name, tricigo_category, category, location, address,
    phone, website, source, source_ids, is_admin, is_active, confidence,
    importance, synced_at, updated_at
  ) VALUES (
    p_name,
    v_category,
    v_category,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_address,
    NULLIF(trim(p_phone), ''),
    NULLIF(trim(p_website), ''),
    'mapbox',
    CASE
      WHEN p_mapbox_id IS NOT NULL THEN jsonb_build_object('mapbox', p_mapbox_id)
      ELSE '{}'::jsonb
    END,
    FALSE,
    TRUE,
    0.8,
    4,
    NOW(),
    NOW()
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('imported', TRUE, 'poi_id', v_new_id, 'reason', 'inserted');
EXCEPTION
  WHEN unique_violation THEN
    v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', v_existing_id, 'reason', 'race_duplicate');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('imported', FALSE, 'poi_id', NULL, 'reason', 'error:' || SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.import_search_poi IS
  'PR 4b (hotfix 00309): drops name_normalized from the INSERT — that column is GENERATED ALWAYS. Behaviour otherwise identical to 00308.';
