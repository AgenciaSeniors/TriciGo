-- ============================================================
-- Migration 00253: Final optimized bulk_upsert_pois
--
-- Consolidates a series of MCP-applied fixes that surfaced during the
-- first full Cuba sync and got rolled back into one source-of-truth
-- migration so cron-driven re-runs and fresh-DB recreations stay in
-- lockstep with what's live in prod.
--
-- Changes vs migration 00251:
--
--   1. SET statement_timeout = '0' at function level so bulk operations
--      against 87K+ existing rows don't trip the default 8s PostgREST
--      timeout (error 57014). Applies for the function's lifetime.
--
--   2. Diagnostic role/uid in the auth-failure error message — surfaced
--      "detected role=anon uid=NULL" when the first run was using a
--      legacy/publishable key instead of the new sb_secret_* secret.
--
--   3. Replace the per-row JSONB containment join with an EXPLODED
--      hash join. Both staging.source_ids and cuba_pois.source_ids get
--      flattened into (key, value) rows in temp tables; we ANALYZE
--      both and then plain hash-join. ~10× faster than nested-loop
--      JSONB at full Cuba scale.
--
--   4. Pre-prune `_existing_keys` to rows whose source_ids share at
--      least one key with the staging set, using `?|` against an array
--      of distinct staging keys. The GIN index on source_ids makes that
--      pre-filter cheap, so the explode stays bounded even when the
--      table grows past 100K rows.
--
--   5. Fallback match: for staging rows that have a non-NULL osm_id /
--      osm_type but didn't match any existing source_ids (e.g. a row
--      whose source_ids got cleared by an earlier failed run), look up
--      by (osm_id, osm_type). Without this, the INSERT below would
--      collide with the legacy UNIQUE (osm_id, osm_type) constraint.
--
--   6. Within-batch dedup of staging rows by (osm_id, osm_type) for
--      non-NULL OSM IDs before INSERT. Catches the rare case where the
--      Python merge step leaves two records with the same OSM identity
--      because they sit >50m apart in the OSM source data.
--
--   7. ON CONFLICT (osm_id, osm_type) WHERE osm_id IS NOT NULL DO
--      UPDATE as a final safety net. Promotes any remaining conflict
--      to an update instead of failing the batch. Admin rows are still
--      protected via the WHERE NOT cuba_pois.is_admin clause.
--
-- The function remains SECURITY DEFINER and rejects calls that aren't
-- service_role (or admin/super_admin via auth.uid()).
-- ============================================================

CREATE OR REPLACE FUNCTION bulk_upsert_pois(p_records JSONB)
RETURNS TABLE(inserted_count BIGINT, updated_count BIGINT, skipped_admin_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
SET statement_timeout = '0'
AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated  BIGINT := 0;
  v_skipped  BIGINT := 0;
  v_now      TIMESTAMPTZ := NOW();
  v_role     TEXT;
  v_uid      UUID;
BEGIN
  v_role := auth.role();
  v_uid  := auth.uid();
  IF NOT (
    v_role = 'service_role'
    OR EXISTS (SELECT 1 FROM users WHERE id = v_uid AND role IN ('admin','super_admin'))
  ) THEN
    RAISE EXCEPTION 'forbidden: service_role or admin required (detected role=% uid=%)',
      COALESCE(v_role, 'NULL'), COALESCE(v_uid::text, 'NULL');
  END IF;
  IF jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'p_records must be a JSON array';
  END IF;

  CREATE TEMP TABLE _staging (
    rec_idx INT GENERATED ALWAYS AS IDENTITY,
    name TEXT,
    category TEXT, subcategory TEXT, tricigo_category TEXT,
    address TEXT, municipality TEXT, province TEXT,
    lat DOUBLE PRECISION, lng DOUBLE PRECISION,
    source TEXT, source_ids JSONB,
    phone TEXT, website TEXT, socials JSONB, hours TEXT,
    confidence REAL, osm_id BIGINT, osm_type TEXT
  ) ON COMMIT DROP;

  INSERT INTO _staging (
    name, category, subcategory, tricigo_category,
    address, municipality, province, lat, lng,
    source, source_ids, phone, website, socials, hours, confidence,
    osm_id, osm_type
  )
  SELECT
    rec->>'name',
    rec->>'category', rec->>'subcategory', rec->>'tricigo_category',
    NULLIF(rec->>'address', ''),
    NULLIF(rec->>'municipality', ''),
    NULLIF(rec->>'province', ''),
    (rec->>'lat')::DOUBLE PRECISION,
    (rec->>'lng')::DOUBLE PRECISION,
    rec->>'source',
    COALESCE(rec->'source_ids', '{}'::jsonb),
    NULLIF(rec->>'phone', ''),
    NULLIF(rec->>'website', ''),
    NULLIF(rec->'socials', 'null'::jsonb),
    NULLIF(rec->>'hours', ''),
    COALESCE((rec->>'confidence')::REAL, 0.5),
    NULLIF(rec->>'osm_id','')::BIGINT,
    NULLIF(rec->>'osm_type','')
  FROM jsonb_array_elements(p_records) rec;

  CREATE TEMP TABLE _staging_keys ON COMMIT DROP AS
  SELECT s.rec_idx, kv.key AS src_key, kv.value AS src_val
  FROM _staging s, jsonb_each_text(s.source_ids) kv
  WHERE jsonb_typeof(s.source_ids) = 'object';
  CREATE INDEX ON _staging_keys (src_key, src_val);

  CREATE TEMP TABLE _existing_keys ON COMMIT DROP AS
  SELECT p.id AS poi_id, p.is_admin, kv.key AS src_key, kv.value AS src_val
  FROM cuba_pois p, jsonb_each_text(p.source_ids) kv
  WHERE jsonb_typeof(p.source_ids) = 'object'
    AND p.source_ids != '{}'::jsonb
    AND p.source_ids ?| (
      SELECT array_agg(DISTINCT src_key) FROM _staging_keys
    );
  CREATE INDEX ON _existing_keys (src_key, src_val);
  ANALYZE _existing_keys;
  ANALYZE _staging_keys;

  CREATE TEMP TABLE _matches ON COMMIT DROP AS
  SELECT DISTINCT ON (sk.rec_idx)
    sk.rec_idx,
    ek.poi_id,
    ek.is_admin
  FROM _staging_keys sk
  JOIN _existing_keys ek
    ON ek.src_key = sk.src_key AND ek.src_val = sk.src_val
  ORDER BY sk.rec_idx, ek.is_admin DESC, ek.poi_id;

  -- Fallback: catch staging rows with osm_id but no source_ids match
  INSERT INTO _matches (rec_idx, poi_id, is_admin)
  SELECT s.rec_idx, p.id, p.is_admin
  FROM _staging s
  JOIN cuba_pois p
    ON p.osm_id = s.osm_id AND p.osm_type = s.osm_type
  WHERE s.osm_id IS NOT NULL
    AND s.osm_type IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM _matches m WHERE m.rec_idx = s.rec_idx);

  v_skipped := (SELECT COUNT(*) FROM _matches WHERE is_admin);

  UPDATE cuba_pois p
  SET
    name = s.name,
    category = s.category, subcategory = s.subcategory, tricigo_category = s.tricigo_category,
    address = COALESCE(s.address, p.address),
    municipality = COALESCE(s.municipality, p.municipality),
    city = COALESCE(s.municipality, p.city),
    province = COALESCE(s.province, p.province),
    location = ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography,
    source = s.source, source_ids = s.source_ids,
    phone = COALESCE(s.phone, p.phone),
    website = COALESCE(s.website, p.website),
    socials = COALESCE(s.socials, p.socials),
    hours = COALESCE(s.hours, p.hours),
    confidence = s.confidence,
    is_active = TRUE, synced_at = v_now, updated_at = v_now
  FROM _staging s
  JOIN _matches m ON m.rec_idx = s.rec_idx
  WHERE p.id = m.poi_id AND NOT m.is_admin;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  WITH unmatched AS (
    SELECT s.*
    FROM _staging s
    WHERE NOT EXISTS (SELECT 1 FROM _matches m WHERE m.rec_idx = s.rec_idx)
  ),
  with_osm AS (
    SELECT DISTINCT ON (osm_id, osm_type) *
    FROM unmatched
    WHERE osm_id IS NOT NULL AND osm_type IS NOT NULL
    ORDER BY osm_id, osm_type, confidence DESC, rec_idx
  ),
  without_osm AS (
    SELECT * FROM unmatched WHERE osm_id IS NULL OR osm_type IS NULL
  )
  INSERT INTO cuba_pois (
    name,
    category, subcategory, tricigo_category,
    address, city, municipality, province,
    location, source, source_ids,
    phone, website, socials, hours,
    confidence, is_admin, is_active,
    synced_at, tags, osm_id, osm_type
  )
  SELECT
    s.name,
    s.category, s.subcategory, s.tricigo_category,
    s.address, s.municipality, s.municipality, s.province,
    ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography,
    s.source, s.source_ids,
    s.phone, s.website, s.socials, s.hours,
    s.confidence, FALSE, TRUE,
    v_now, '{}'::jsonb, s.osm_id, s.osm_type
  FROM (
    SELECT * FROM with_osm
    UNION ALL
    SELECT * FROM without_osm
  ) s
  ON CONFLICT (osm_id, osm_type) WHERE osm_id IS NOT NULL DO UPDATE
  SET
    name = EXCLUDED.name,
    category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
    tricigo_category = EXCLUDED.tricigo_category,
    address = COALESCE(EXCLUDED.address, cuba_pois.address),
    location = EXCLUDED.location,
    source = EXCLUDED.source, source_ids = EXCLUDED.source_ids,
    phone = COALESCE(EXCLUDED.phone, cuba_pois.phone),
    website = COALESCE(EXCLUDED.website, cuba_pois.website),
    socials = COALESCE(EXCLUDED.socials, cuba_pois.socials),
    hours = COALESCE(EXCLUDED.hours, cuba_pois.hours),
    confidence = EXCLUDED.confidence,
    is_active = TRUE, synced_at = EXCLUDED.synced_at, updated_at = NOW()
  WHERE NOT cuba_pois.is_admin;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  inserted_count := v_inserted;
  updated_count := v_updated;
  skipped_admin_count := v_skipped;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_upsert_pois(JSONB) TO service_role, authenticated;

-- GIN index on source_ids — used by the explode pre-filter (`?|` array
-- of keys) and by ad-hoc admin queries. Idempotent.
CREATE INDEX IF NOT EXISTS idx_cuba_pois_source_ids_gin
  ON cuba_pois USING gin (source_ids);
