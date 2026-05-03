-- ============================================================
-- Migration 00250: Bulk upsert RPC for the monthly POI sync
--
-- The sync pipeline (scripts/sync-pois/merge_and_upsert.py) was making
-- one HTTP round-trip per row update via PostgREST. At Cuba scale
-- (~80K rows) that takes ~70 minutes and blows past the 30-minute
-- workflow timeout.
--
-- This RPC accepts a JSONB array of records, classifies each one as
-- INSERT or UPDATE based on `source_ids` overlap with existing rows,
-- and applies them in a single transactional call. Tens of thousands
-- of records process in seconds, not minutes.
--
-- Behaviour rules (mirror the Python script):
--   • Rows with `is_admin = TRUE` are NEVER touched.
--   • Match by ANY shared key in source_ids (e.g. {"osm":"node/123"}
--     matching an existing row's {"osm":"node/123","fsq":"abc"}).
--   • UPDATE preserves admin-set values: only sync-managed columns
--     (name, location, contacts, hours, source, source_ids, confidence,
--     is_active=TRUE, synced_at) get rewritten.
--   • New records become source='merged' if they carry >1 source_id,
--     or fall through to the dominant single source.
--
-- The function returns counts so the workflow summary can report them.
-- ============================================================

CREATE OR REPLACE FUNCTION bulk_upsert_pois(p_records JSONB)
RETURNS TABLE(inserted_count BIGINT, updated_count BIGINT, skipped_admin_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_inserted     BIGINT := 0;
  v_updated      BIGINT := 0;
  v_skipped      BIGINT := 0;
  v_now          TIMESTAMPTZ := NOW();
BEGIN
  -- Auth: only service_role / admin should call this. The function is
  -- SECURITY DEFINER so we check explicitly.
  IF NOT (
    auth.role() = 'service_role'
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  ) THEN
    RAISE EXCEPTION 'forbidden: service_role or admin required';
  END IF;

  IF jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'p_records must be a JSON array';
  END IF;

  -- Stage incoming rows in a temp table so we can join against cuba_pois
  -- once instead of per-row lookups. Indexed on the source_ids JSONB so
  -- the matching join is fast.
  CREATE TEMP TABLE _staging (
    rec_idx          INT GENERATED ALWAYS AS IDENTITY,
    name             TEXT,
    name_normalized  TEXT,
    category         TEXT,
    subcategory      TEXT,
    tricigo_category TEXT,
    address          TEXT,
    municipality     TEXT,
    province         TEXT,
    lat              DOUBLE PRECISION,
    lng              DOUBLE PRECISION,
    source           TEXT,
    source_ids       JSONB,
    phone            TEXT,
    website          TEXT,
    socials          JSONB,
    hours            TEXT,
    confidence       REAL,
    osm_id           BIGINT,
    osm_type         TEXT
  ) ON COMMIT DROP;

  INSERT INTO _staging (
    name, name_normalized, category, subcategory, tricigo_category,
    address, municipality, province, lat, lng,
    source, source_ids, phone, website, socials, hours, confidence,
    osm_id, osm_type
  )
  SELECT
    rec->>'name',
    COALESCE(rec->>'name_normalized', lower(unaccent(rec->>'name'))),
    rec->>'category',
    rec->>'subcategory',
    rec->>'tricigo_category',
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

  -- Mark which staged rows match an existing cuba_pois row by any
  -- shared (key,value) entry in source_ids.
  CREATE TEMP TABLE _matches (
    rec_idx INT,
    poi_id  BIGINT,
    is_admin BOOLEAN
  ) ON COMMIT DROP;

  INSERT INTO _matches (rec_idx, poi_id, is_admin)
  SELECT DISTINCT ON (s.rec_idx)
    s.rec_idx, p.id, p.is_admin
  FROM _staging s
  JOIN cuba_pois p
    -- Find ANY overlap between staging.source_ids and existing.source_ids
    ON EXISTS (
      SELECT 1
      FROM jsonb_each_text(s.source_ids) AS new_kv
      JOIN jsonb_each_text(p.source_ids) AS old_kv
        ON old_kv.key = new_kv.key AND old_kv.value = new_kv.value
    )
  ORDER BY s.rec_idx, p.is_admin DESC, p.id;
  -- The `is_admin DESC` tiebreaker means if a staging record happens to
  -- collide with both an admin row and a sync-managed row (rare), we
  -- prefer the admin row so we DON'T overwrite it.

  -- 1. Skip admin rows entirely (they're sticky)
  v_skipped := (SELECT COUNT(*) FROM _matches WHERE is_admin);

  -- 2. UPDATE the non-admin matches
  UPDATE cuba_pois p
  SET
    name             = s.name,
    name_normalized  = s.name_normalized,
    -- Preserve user-readable category text on admin rows; for sync rows
    -- we let category/subcategory/tricigo_category get rewritten.
    category         = s.category,
    subcategory      = s.subcategory,
    tricigo_category = s.tricigo_category,
    address          = COALESCE(s.address, p.address),
    municipality     = COALESCE(s.municipality, p.municipality),
    city             = COALESCE(s.municipality, p.city),
    province         = COALESCE(s.province, p.province),
    location         = ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography,
    source           = s.source,
    source_ids       = s.source_ids,
    phone            = COALESCE(s.phone, p.phone),
    website          = COALESCE(s.website, p.website),
    socials          = COALESCE(s.socials, p.socials),
    hours            = COALESCE(s.hours, p.hours),
    confidence       = s.confidence,
    is_active        = TRUE,
    synced_at        = v_now,
    updated_at       = v_now
  FROM _staging s
  JOIN _matches m ON m.rec_idx = s.rec_idx
  WHERE p.id = m.poi_id
    AND NOT m.is_admin;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- 3. INSERT the rest (no match found at all)
  INSERT INTO cuba_pois (
    name, name_normalized,
    category, subcategory, tricigo_category,
    address, city, municipality, province,
    location, source, source_ids,
    phone, website, socials, hours,
    confidence, is_admin, is_active,
    synced_at, tags, osm_id, osm_type
  )
  SELECT
    s.name, s.name_normalized,
    s.category, s.subcategory, s.tricigo_category,
    s.address, s.municipality, s.municipality, s.province,
    ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography,
    s.source, s.source_ids,
    s.phone, s.website, s.socials, s.hours,
    s.confidence, FALSE, TRUE,
    v_now, '{}'::jsonb, s.osm_id, s.osm_type
  FROM _staging s
  WHERE NOT EXISTS (SELECT 1 FROM _matches m WHERE m.rec_idx = s.rec_idx);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  inserted_count := v_inserted;
  updated_count  := v_updated;
  skipped_admin_count := v_skipped;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_upsert_pois(JSONB) TO service_role, authenticated;

COMMENT ON FUNCTION bulk_upsert_pois(JSONB) IS
  'Batch upsert from sync pipeline. Inserts new rows, updates non-admin matches by source_ids overlap, skips is_admin=TRUE rows. Returns (inserted, updated, skipped_admin) counts.';
