-- ============================================================
-- Migration 00106: Create cuba_pois table schema + performance indexes
-- F401: Table was only created by import script, not by migration
-- F402: Add GIN pg_trgm index for fast fuzzy text search
-- ============================================================

-- Create table if not exists (import script may have already created it)
CREATE TABLE IF NOT EXISTS cuba_pois (
  id BIGSERIAL PRIMARY KEY,
  osm_id BIGINT,
  osm_type TEXT,
  name TEXT NOT NULL,
  name_normalized TEXT,
  category TEXT,
  subcategory TEXT,
  address TEXT,
  city TEXT,
  neighborhood TEXT,
  location GEOGRAPHY(POINT, 4326),
  tags JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for proximity queries
CREATE INDEX IF NOT EXISTS idx_cuba_pois_location ON cuba_pois USING gist (location);

-- B-tree indexes for exact lookups
CREATE INDEX IF NOT EXISTS idx_cuba_pois_name ON cuba_pois (name);
CREATE INDEX IF NOT EXISTS idx_cuba_pois_category ON cuba_pois (category);

-- F402: GIN pg_trgm index for fast fuzzy/ILIKE search on name_normalized
-- pg_trgm is already enabled (migration 00001)
CREATE INDEX IF NOT EXISTS idx_cuba_pois_name_trgm
  ON cuba_pois USING gin (name_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_cuba_pois_name_orig_trgm
  ON cuba_pois USING gin (name gin_trgm_ops);

-- RLS: read-only for authenticated and anon
ALTER TABLE cuba_pois ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cuba_pois' AND policyname = 'cuba_pois_read') THEN
    CREATE POLICY cuba_pois_read ON cuba_pois FOR SELECT USING (true);
  END IF;
END $$;
