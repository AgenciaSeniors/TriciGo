-- ============================================================
-- Migration 00308: Mapbox-backed POI growth on search-select (PR 4b)
--
-- Extends the search → cuba_pois pipeline so that when a user selects
-- a search result (Google Places or otherwise), the Edge Function
-- `import-mapbox-poi` can look up the same place on Mapbox SearchBox
-- and persist it to cuba_pois with source='mapbox'.
--
-- Why Mapbox and not Google: Google Places TOS section 3.2.3 forbids
-- persistent storage of Google content beyond a 30-day cache and
-- forbids serving that content to users other than the one who
-- searched. Mapbox SearchBox TOS explicitly allows permanent storage
-- and re-display. So we keep using Google for the search dropdown
-- UX (the "Powered by Google" badge stays where it's mandatory),
-- and let Mapbox fill cuba_pois behind the scenes — the user only
-- ever sees pins on the map sourced from cuba_pois (no Google data
-- ever pinned).
--
-- This migration is purely additive:
--   * extends cuba_pois_source_check to allow 'mapbox'
--   * adds helper find_nearby_poi_match for spatial+name dedup
--   * adds RPC import_search_poi that the EF calls
-- No existing data is touched.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- 1. Allow 'mapbox' as a source value
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE public.cuba_pois
  DROP CONSTRAINT IF EXISTS cuba_pois_source_check;

ALTER TABLE public.cuba_pois
  ADD CONSTRAINT cuba_pois_source_check
  CHECK (source IN (
    'admin',
    'osm',
    'overture',
    'foursquare',
    'merged',
    'crowdsource',
    'wikidata',
    'mapbox'
  ));


-- ─────────────────────────────────────────────────────────────────
-- 2. Helper: find_nearby_poi_match
--
-- Given a candidate (name, lat, lng), returns the id of an existing
-- active cuba_pois row within `p_radius_m` meters whose normalized
-- name is sufficiently similar (>= 0.6 trgm similarity).
--
-- Used by import_search_poi to dedup before inserting. Also used by
-- callers/tests via service_role to verify dedup behaviour.
--
-- Returns NULL when no match.
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.find_nearby_poi_match(
  p_name TEXT,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_m INT DEFAULT 50
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_norm TEXT;
  v_id BIGINT;
BEGIN
  IF p_name IS NULL OR length(p_name) < 2 THEN
    RETURN NULL;
  END IF;

  v_norm := lower(unaccent(p_name));

  SELECT cp.id
  INTO v_id
  FROM public.cuba_pois cp
  WHERE cp.is_active
    AND cp.location IS NOT NULL
    AND ST_DWithin(
          cp.location,
          ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
          p_radius_m
        )
    AND cp.name_normalized IS NOT NULL
    AND similarity(cp.name_normalized, v_norm) >= 0.6
  ORDER BY similarity(cp.name_normalized, v_norm) DESC,
           ST_Distance(
             cp.location,
             ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
           ) ASC
  LIMIT 1;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.find_nearby_poi_match IS
  'Returns id of an existing active POI within p_radius_m meters whose name is >=0.6 trgm-similar to p_name, or NULL. Used by import_search_poi for dedup.';

REVOKE ALL ON FUNCTION public.find_nearby_poi_match FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_nearby_poi_match TO service_role, authenticated;


-- ─────────────────────────────────────────────────────────────────
-- 3. RPC: import_search_poi
--
-- Called by the import-mapbox-poi Edge Function after Mapbox returns
-- a matching POI for the user's search query.
--
-- Behaviour:
--   1. Validate lat/lng is within Cuba bbox (sanity guard).
--   2. Look for a nearby existing POI (50 m + name similarity).
--   3. If found and the existing row is admin-curated → no-op
--      (we never modify admin POIs).
--   4. If found and not admin → enrich source_ids with {mapbox: id}
--      (no-op if the mapbox id is already present), return imported=false.
--   5. If not found → INSERT with source='mapbox', confidence=0.8.
--      The 00307 trigger auto-computes importance.
--
-- Returns JSONB: { imported: bool, poi_id: bigint | null,
--                  reason: text }
-- ─────────────────────────────────────────────────────────────────

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
  -- Input validation
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', NULL,
      'reason', 'name_too_short'
    );
  END IF;

  IF p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', NULL,
      'reason', 'missing_coords'
    );
  END IF;

  -- Cuba bbox sanity guard (rejects accidental imports outside the
  -- service area — Mapbox already filters by country=cu but defence
  -- in depth).
  IF p_lat < 19.5 OR p_lat > 23.5 OR p_lng < -85.0 OR p_lng > -74.0 THEN
    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', NULL,
      'reason', 'out_of_cuba'
    );
  END IF;

  -- Normalize tricigo_category against the allow-list. Unknown values
  -- fall through to 'other' (00302 trigger may re-categorize later
  -- from the OSM tag mapper if applicable).
  v_category := CASE
    WHEN p_tricigo_category IN (
      'hospital','hotel','museum','gov','school','religion','park',
      'beach','bank','pharmacy','embassy','transport','gas_station',
      'supermarket','restaurant','paladar','cafe','bar','shop','atm'
    ) THEN p_tricigo_category
    ELSE 'other'
  END;

  -- Dedup: existing match within 50 m + name similarity ≥ 0.6
  v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);

  IF v_existing_id IS NOT NULL THEN
    SELECT is_admin, source_ids
      INTO v_is_admin, v_existing_ids
    FROM public.cuba_pois
    WHERE id = v_existing_id;

    -- Admin rows are sacred — never touch
    IF v_is_admin THEN
      RETURN jsonb_build_object(
        'imported', FALSE,
        'poi_id', v_existing_id,
        'reason', 'admin_match'
      );
    END IF;

    -- Enrich source_ids with mapbox id if we have one and it's not there
    IF p_mapbox_id IS NOT NULL
       AND (v_existing_ids IS NULL OR NOT (v_existing_ids ? 'mapbox')) THEN
      UPDATE public.cuba_pois
      SET source_ids = COALESCE(source_ids, '{}'::jsonb)
                       || jsonb_build_object('mapbox', p_mapbox_id),
          updated_at = NOW()
      WHERE id = v_existing_id;
    END IF;

    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', v_existing_id,
      'reason', 'duplicate_within_50m'
    );
  END IF;

  -- New POI: insert it. importance is computed by tg_cuba_pois_set_importance
  -- (00307 v2). We seed with 4 as a placeholder; the BEFORE INSERT trigger
  -- overrides via compute_poi_importance(NEW).
  INSERT INTO public.cuba_pois (
    name,
    name_normalized,
    tricigo_category,
    category,
    location,
    address,
    phone,
    website,
    source,
    source_ids,
    is_admin,
    is_active,
    confidence,
    importance,
    synced_at,
    updated_at
  ) VALUES (
    p_name,
    lower(unaccent(p_name)),
    v_category,
    v_category,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_address,
    NULLIF(trim(p_phone), ''),
    NULLIF(trim(p_website), ''),
    'mapbox',
    CASE
      WHEN p_mapbox_id IS NOT NULL
        THEN jsonb_build_object('mapbox', p_mapbox_id)
      ELSE '{}'::jsonb
    END,
    FALSE,
    TRUE,
    0.8,
    4,
    NOW(),
    NOW()
  ) RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'imported', TRUE,
    'poi_id', v_new_id,
    'reason', 'inserted'
  );
EXCEPTION
  WHEN unique_violation THEN
    -- Defensive: if a parallel call inserted the same row first,
    -- treat it as a duplicate and find the row again.
    v_existing_id := public.find_nearby_poi_match(p_name, p_lat, p_lng, 50);
    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', v_existing_id,
      'reason', 'race_duplicate'
    );
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'imported', FALSE,
      'poi_id', NULL,
      'reason', 'error:' || SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION public.import_search_poi IS
  'PR 4b: called by import-mapbox-poi Edge Function. Dedups against existing cuba_pois within 50m + name similarity. Inserts new rows with source=mapbox / confidence=0.8 / importance auto-computed by 00307 trigger.';

REVOKE ALL ON FUNCTION public.import_search_poi FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_search_poi TO authenticated, service_role;
