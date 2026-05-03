-- ============================================================
-- Migration 00251: Fix bulk_upsert_pois — name_normalized is generated
--
-- The 00250 RPC tried to INSERT/UPDATE cuba_pois.name_normalized, but
-- that column was created as GENERATED ALWAYS by an earlier migration:
--
--   name_normalized = lower(immutable_unaccent(name))
--
-- Postgres rejects writes to generated columns with:
--   ERROR 428C9: column "name_normalized" can only be updated to DEFAULT
--
-- This migration replaces the function with a version that omits the
-- column from both UPDATE and INSERT — Postgres derives it from `name`
-- automatically. The staging temp table also drops the column since
-- we never read it back.
--
-- Behaviour is otherwise identical to 00250.
-- ============================================================

CREATE OR REPLACE FUNCTION bulk_upsert_pois(p_records JSONB)
RETURNS TABLE(inserted_count BIGINT, updated_count BIGINT, skipped_admin_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_inserted BIGINT := 0;
  v_updated  BIGINT := 0;
  v_skipped  BIGINT := 0;
  v_now      TIMESTAMPTZ := NOW();
BEGIN
  IF NOT (
    auth.role() = 'service_role'
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin'))
  ) THEN
    RAISE EXCEPTION 'forbidden: service_role or admin required';
  END IF;
  IF jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'p_records must be a JSON array';
  END IF;

  CREATE TEMP TABLE _staging (
    rec_idx INT GENERATED ALWAYS AS IDENTITY,
    name TEXT,
    -- Note: name_normalized is intentionally NOT staged. cuba_pois has it
    -- as a generated column derived from name; we'd be wasting space and
    -- inviting drift if we tried to carry it through.
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

  CREATE TEMP TABLE _matches (
    rec_idx INT, poi_id BIGINT, is_admin BOOLEAN
  ) ON COMMIT DROP;

  INSERT INTO _matches (rec_idx, poi_id, is_admin)
  SELECT DISTINCT ON (s.rec_idx)
    s.rec_idx, p.id, p.is_admin
  FROM _staging s
  JOIN cuba_pois p
    ON EXISTS (
      SELECT 1
      FROM jsonb_each_text(s.source_ids) AS new_kv
      JOIN jsonb_each_text(p.source_ids) AS old_kv
        ON old_kv.key = new_kv.key AND old_kv.value = new_kv.value
    )
  ORDER BY s.rec_idx, p.is_admin DESC, p.id;

  v_skipped := (SELECT COUNT(*) FROM _matches WHERE is_admin);

  -- name_normalized is NOT updated explicitly; Postgres regenerates it
  -- from the new `name` value automatically.
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

  -- name_normalized is NOT in the column list; Postgres computes it from name.
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
  FROM _staging s
  WHERE NOT EXISTS (SELECT 1 FROM _matches m WHERE m.rec_idx = s.rec_idx);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  inserted_count := v_inserted;
  updated_count := v_updated;
  skipped_admin_count := v_skipped;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION bulk_upsert_pois(JSONB) TO service_role, authenticated;
