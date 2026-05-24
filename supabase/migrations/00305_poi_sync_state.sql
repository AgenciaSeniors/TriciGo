-- ============================================================
-- Migration 00305: POI sync state tracking
--
-- PR 5 of the POI parity program. Adds state-tracking infrastructure
-- for the daily OSM delta sync (sync-osm-delta.yml) so consecutive runs
-- continue from the last applied Geofabrik replication sequence number
-- without re-downloading the full PBF.
--
-- Why a server-side table (vs GH Actions cache or commit-back):
--   - GH Actions cache is volatile (purged after 7 days of inactivity)
--   - Commit-back creates noise in git log + race conditions on retries
--   - Supabase is already in our stack — same DB where data lives
--
-- One row per region (currently only 'cuba'). Future regions could be
-- added without schema changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.poi_sync_state (
  region          TEXT PRIMARY KEY,                    -- e.g. 'cuba'
  last_sequence   BIGINT NOT NULL,                     -- Geofabrik replication sequence
  last_sync_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_kind  TEXT NOT NULL DEFAULT 'delta'        -- 'delta' (daily) or 'full' (weekly)
    CHECK (last_sync_kind IN ('delta', 'full')),
  stats           JSONB,                                -- per-run insert/update/delete counts (for monitoring)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.poi_sync_state IS
  'Tracks the last applied OSM replication sequence per region. Updated by sync-osm-delta.yml (daily) and sync-pois.yml (weekly full sync).';

-- RLS — only service_role accesses this (sync scripts authenticate as service)
ALTER TABLE public.poi_sync_state ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated/anon — service_role bypasses RLS.


-- ─────────────────────────────────────────────────────────────────
-- RPC: poi_sync_state_get(region) → JSONB | NULL
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.poi_sync_state_get(p_region TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT last_sequence, last_sync_at, last_sync_kind, stats
    INTO v_row
    FROM public.poi_sync_state
   WHERE region = p_region;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'last_sequence', v_row.last_sequence,
    'last_sync_at', v_row.last_sync_at,
    'last_sync_kind', v_row.last_sync_kind,
    'stats', v_row.stats
  );
END;
$$;

REVOKE ALL ON FUNCTION public.poi_sync_state_get FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poi_sync_state_get TO service_role;


-- ─────────────────────────────────────────────────────────────────
-- RPC: poi_sync_state_set(region, sequence, kind, stats) → VOID
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.poi_sync_state_set(
  p_region TEXT,
  p_sequence BIGINT,
  p_kind TEXT,
  p_stats JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_kind NOT IN ('delta', 'full') THEN
    RAISE EXCEPTION 'invalid sync kind: %', p_kind;
  END IF;

  INSERT INTO public.poi_sync_state (
    region, last_sequence, last_sync_at, last_sync_kind, stats, updated_at
  ) VALUES (
    p_region, p_sequence, NOW(), p_kind, p_stats, NOW()
  )
  ON CONFLICT (region) DO UPDATE
    SET last_sequence = EXCLUDED.last_sequence,
        last_sync_at = NOW(),
        last_sync_kind = EXCLUDED.last_sync_kind,
        stats = EXCLUDED.stats,
        updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.poi_sync_state_set FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.poi_sync_state_set TO service_role;

COMMENT ON FUNCTION public.poi_sync_state_set IS
  'Updates the sync state for a region. Called by sync-osm-delta.yml (kind=delta) and sync-pois.yml (kind=full).';


-- ─────────────────────────────────────────────────────────────────
-- RPC: apply_osm_delta_batch(events JSONB) → JSONB
--
-- Called by the daily Python script with a batch of {op, osm_id, osm_type,
-- name, lat, lng, tags} events parsed from .osc.gz. Returns counts.
--
-- - CREATE: insert if osm_id not already present (filters out by source_ids)
-- - MODIFY: update existing row (respects is_admin protection)
-- - DELETE: set is_active=false (respects is_admin protection)
--
-- The trigger from migration 00302 (tg_pois_default_tricigo_category) takes
-- care of populating tricigo_category from tags when we pass `category` from
-- the OSM key (amenity, shop, tourism, etc.).
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_osm_delta_batch(p_events JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event JSONB;
  v_op TEXT;
  v_osm_id BIGINT;
  v_osm_type TEXT;
  v_name TEXT;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_category TEXT;
  v_subcategory TEXT;
  v_tags JSONB;
  v_inserted INTEGER := 0;
  v_updated INTEGER := 0;
  v_deactivated INTEGER := 0;
  v_skipped_admin INTEGER := 0;
  v_skipped_unmapped INTEGER := 0;
  v_rowcount INTEGER;
BEGIN
  IF p_events IS NULL OR jsonb_typeof(p_events) <> 'array' THEN
    RETURN jsonb_build_object('error', 'events must be a JSONB array');
  END IF;

  FOR v_event IN SELECT jsonb_array_elements(p_events) LOOP
    v_op := v_event ->> 'op';
    v_osm_id := (v_event ->> 'osm_id')::BIGINT;
    v_osm_type := v_event ->> 'osm_type';

    IF v_op IS NULL OR v_osm_id IS NULL OR v_osm_type IS NULL THEN
      v_skipped_unmapped := v_skipped_unmapped + 1;
      CONTINUE;
    END IF;

    IF v_op = 'DELETE' THEN
      -- Soft-delete: respect is_admin
      UPDATE public.cuba_pois
         SET is_active = FALSE,
             updated_at = NOW()
       WHERE osm_id = v_osm_id
         AND osm_type = v_osm_type
         AND is_admin = FALSE
         AND is_active = TRUE;
      GET DIAGNOSTICS v_rowcount = ROW_COUNT;
      v_deactivated := v_deactivated + v_rowcount;
      CONTINUE;
    END IF;

    -- CREATE or MODIFY both need geom + category
    v_name := v_event ->> 'name';
    v_lat := (v_event ->> 'lat')::DOUBLE PRECISION;
    v_lng := (v_event ->> 'lng')::DOUBLE PRECISION;
    v_category := v_event ->> 'category';
    v_subcategory := v_event ->> 'subcategory';
    v_tags := v_event -> 'tags';

    IF v_lat IS NULL OR v_lng IS NULL OR v_name IS NULL OR length(trim(v_name)) < 1 THEN
      v_skipped_unmapped := v_skipped_unmapped + 1;
      CONTINUE;
    END IF;

    -- Cuba bbox sanity
    IF v_lat < 19.5 OR v_lat > 23.5 OR v_lng < -85.0 OR v_lng > -74.0 THEN
      v_skipped_unmapped := v_skipped_unmapped + 1;
      CONTINUE;
    END IF;

    IF v_op = 'CREATE' OR v_op = 'MODIFY' THEN
      -- Upsert via osm_id + osm_type. is_admin check on UPDATE.
      INSERT INTO public.cuba_pois (
        osm_id, osm_type, name, name_normalized,
        category, subcategory, location, tags,
        source, source_ids, is_admin, is_active,
        confidence, importance, synced_at, updated_at
      ) VALUES (
        v_osm_id, v_osm_type, trim(v_name),
        lower(unaccent(trim(v_name))),
        v_category, v_subcategory,
        ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography,
        COALESCE(v_tags, '{}'::jsonb),
        'osm',
        jsonb_build_object('osm', v_osm_type || '/' || v_osm_id::TEXT),
        FALSE, TRUE,
        0.5, 4, NOW(), NOW()
      )
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_rowcount = ROW_COUNT;
      IF v_rowcount > 0 THEN
        v_inserted := v_inserted + 1;
        CONTINUE;
      END IF;

      -- Row already exists — MODIFY path. Skip admin-curated.
      UPDATE public.cuba_pois
         SET name = trim(v_name),
             name_normalized = lower(unaccent(trim(v_name))),
             category = v_category,
             subcategory = COALESCE(v_subcategory, subcategory),
             location = ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326)::geography,
             tags = COALESCE(v_tags, tags),
             is_active = TRUE,
             updated_at = NOW()
       WHERE osm_id = v_osm_id
         AND osm_type = v_osm_type
         AND is_admin = FALSE;
      GET DIAGNOSTICS v_rowcount = ROW_COUNT;
      IF v_rowcount > 0 THEN
        v_updated := v_updated + 1;
      ELSE
        v_skipped_admin := v_skipped_admin + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'deactivated', v_deactivated,
    'skipped_admin', v_skipped_admin,
    'skipped_unmapped', v_skipped_unmapped
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_osm_delta_batch FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_osm_delta_batch TO service_role;

COMMENT ON FUNCTION public.apply_osm_delta_batch IS
  'Applies a batch of OSM delta events to cuba_pois. Respects is_admin (never overwrites admin-curated). Used by sync-osm-delta.yml.';
