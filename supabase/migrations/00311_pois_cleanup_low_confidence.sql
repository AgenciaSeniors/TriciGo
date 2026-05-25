-- ============================================================
-- Migration 00311: aggressive cleanup of low-confidence and
-- coord-clustered POIs (PR E of viewport+cleanup+search program)
--
-- Bug context (verified 2026-05-25):
--   The user searched "aeropuerto" and saw TWO results for the
--   Habana airport. The first (Google Places) had correct coords;
--   the second (cuba_pois `Aeropuerto Internacional José Martí`,
--   source=overture, importance=2) pointed to a random spot in
--   Habana centro — NOT to Boyeros where the actual airport is.
--
--   DB investigation revealed the smoking gun: at coords
--   (23.1319, -82.3642) — Habana centro — there are 44 POIs
--   stacked at the EXACT same location, including the airport,
--   "Casa Del Artesano", "Apartamento privado YSA", etc. That's
--   clearly the result of Overture's geocoding falling back to
--   the municipality centroid when the actual address can't be
--   resolved. The user got routed to that fake centroid.
--
--   15 such coord-clusters detected (5-236 POIs each, ~600 total).
--   Separately, ~70k POIs sit at confidence < 0.6 (mostly OSM
--   stock data at the default 0.5) which is below the user-set
--   quality bar.
--
-- This migration runs both cleanups in one transaction:
--   Step 1: deactivate POIs with confidence < 0.6, EXCEPT
--           - is_admin = true (curated, sacred)
--           - source IN ('admin','wikidata','crowdsource') (trusted)
--   Step 2: deactivate POIs whose coords match any cluster of
--           5+ POIs at the same lat/lng (4-decimal precision ≈ 11 m).
--           Same exception list as step 1.
--
-- ALL using is_active = FALSE (not DELETE) so the operation is
-- fully reversible if the cleanup turns out too aggressive. To
-- restore: `UPDATE cuba_pois SET is_active = TRUE WHERE updated_at = '<this migration timestamp>'`.
--
-- Expected outcome:
--   active POIs:    108k → ~38k
--   - admin:        ~390 unchanged
--   - wikidata:     ~all kept
--   - crowdsource:  ~all kept
--   - foursquare:   ~3,500 kept (avg confidence 0.70)
--   - overture:     ~7k kept (of 15k)
--   - merged:       ~12k kept (of 20k)
--   - osm:          ~5k kept (of 70k — only OSM enriched w/ phone/website)
--
-- Combined with PR D viewport visibility fix (more POIs per bbox)
-- and PR F search ranking (Google first), the user gets fewer but
-- more accurate POIs both on the map and in search.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Step 1: deactivate low-confidence POIs
-- ────────────────────────────────────────────────────────────
WITH affected AS (
  UPDATE public.cuba_pois
  SET is_active = FALSE,
      updated_at = NOW()
  WHERE is_active = TRUE
    AND confidence < 0.6
    AND NOT is_admin
    AND source NOT IN ('admin', 'wikidata', 'crowdsource')
  RETURNING id
)
SELECT count(*) AS step1_deactivated_low_confidence FROM affected;


-- ────────────────────────────────────────────────────────────
-- Step 2: deactivate coord-cluster POIs (>= 5 at same lat/lng)
-- ────────────────────────────────────────────────────────────
WITH bad_coords AS (
  SELECT
    ROUND(ST_Y(location::geometry)::numeric, 4) AS lat_rounded,
    ROUND(ST_X(location::geometry)::numeric, 4) AS lng_rounded
  FROM public.cuba_pois
  WHERE is_active = TRUE
  GROUP BY 1, 2
  HAVING COUNT(*) >= 5
),
affected AS (
  UPDATE public.cuba_pois
  SET is_active = FALSE,
      updated_at = NOW()
  WHERE is_active = TRUE
    AND NOT is_admin
    AND source NOT IN ('admin', 'wikidata', 'crowdsource')
    AND (
      ROUND(ST_Y(location::geometry)::numeric, 4),
      ROUND(ST_X(location::geometry)::numeric, 4)
    ) IN (SELECT lat_rounded, lng_rounded FROM bad_coords)
  RETURNING id
)
SELECT count(*) AS step2_deactivated_coord_clusters FROM affected;


-- ────────────────────────────────────────────────────────────
-- Reporting view: post-cleanup distribution by source
-- ────────────────────────────────────────────────────────────
-- After applying, run:
--   SELECT source,
--          COUNT(*) FILTER (WHERE is_active) AS active,
--          COUNT(*) FILTER (WHERE NOT is_active) AS deactivated,
--          ROUND(AVG(confidence) FILTER (WHERE is_active)::numeric, 2) AS avg_conf_active
--   FROM cuba_pois GROUP BY source ORDER BY active DESC;
