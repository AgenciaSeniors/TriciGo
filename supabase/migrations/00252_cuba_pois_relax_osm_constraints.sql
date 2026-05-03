-- ============================================================
-- Migration 00252: Drop NOT NULL on cuba_pois.osm_id / osm_type
--
-- The original schema (migration 00106) declared osm_id/osm_type as
-- NOT NULL because the table was OSM-only at the time. With the
-- multi-source extension (migration 00248) the table now also holds:
--   • admin-curated rows (no OSM identity)
--   • Foursquare rows (fsq_place_id, no OSM)
--   • Overture rows (overture id, no OSM)
--   • merged rows (might have OSM, might not)
--
-- The bulk_upsert_pois RPC kept failing with:
--   ERROR 23502: null value in column "osm_id" ... violates not-null
--
-- Drop the NOT NULL on both columns. Existing OSM rows keep their values.
-- New non-OSM rows leave them NULL. Lookups that JOIN on osm_id are
-- unchanged because they filter `WHERE osm_id IS NOT NULL` implicitly.
-- ============================================================

ALTER TABLE cuba_pois ALTER COLUMN osm_id   DROP NOT NULL;
ALTER TABLE cuba_pois ALTER COLUMN osm_type DROP NOT NULL;
