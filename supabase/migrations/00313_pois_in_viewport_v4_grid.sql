-- ============================================================
-- Migration 00313: pois_in_viewport v4 — grid-based dispersion
--
-- Builds on 00310 (v3) by replacing the global `ORDER BY importance
-- LIMIT N` ranking with a **5×5 grid dispersion** over the viewport.
-- The bbox is divided into 25 cells; we take the top-K POIs per cell
-- (by is_admin DESC, importance ASC). This guarantees coverage of the
-- periphery even when the centre is saturated.
--
-- Bug the user reported on-device 2026-05-25 (post-PR-D screenshots):
--   * Screenshot 1 (zoom 14, Centro Habana): ~900 POIs returned, all
--     concentrated in 1 km² because the global LIMIT 900 keeps only
--     the importance-≤4 set and Centro has thousands of them. Result:
--     Mapbox renders them on top of each other (cluttering).
--   * Screenshot 5 (zoom 14, Mazorra/Managua): periphery completely
--     empty. Same global LIMIT 900 left all slots for Centro.
--
-- The fix has two complementary parts:
--   1. **This migration** (server side): grid dispersion redistributes
--      the LIMIT across cells, so periphery cells with 5-10 POIs all
--      get returned while dense Centro cells get capped at K per cell.
--   2. `PoiMapLayers.tsx` (client side, same PR): `iconAllowOverlap:
--      false` + `symbolSortKey: importance` so Mapbox auto-hides the
--      pins that would still visually overlap, prioritizing tier-1.
--
-- Per-cell K: scales with the per-zoom `max_results` cap from v3.
-- At zoom 14 (max_results=900), K = max(8, 900/25) = 36 per cell, so
-- 25 cells × 36 ≈ 900 total in the worst case. At zoom 17 (max=2000),
-- K = max(8, 80) = 80 per cell.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Caller signature unchanged.
-- ============================================================

CREATE OR REPLACE FUNCTION public.pois_in_viewport(
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  zoom_level integer DEFAULT 13,
  max_results integer DEFAULT 1500
)
RETURNS TABLE(
  id bigint,
  name text,
  category text,
  subcategory text,
  tricigo_category text,
  lat double precision,
  lng double precision,
  address text,
  importance smallint,
  is_admin boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible AS (
    SELECT
      cp.id,
      cp.name,
      cp.category,
      cp.subcategory,
      cp.tricigo_category,
      ST_Y(cp.location::geometry) AS lat,
      ST_X(cp.location::geometry) AS lng,
      cp.address,
      cp.importance,
      cp.is_admin,
      -- 5×5 grid over the bbox. FLOOR clamps to integers; LEAST handles
      -- the edge case where a POI sits exactly on the max boundary
      -- (lng=max_lng → FLOOR would give 5, push back to 4).
      LEAST(4, GREATEST(0, FLOOR(
        5.0 * (ST_X(cp.location::geometry) - min_lng) / NULLIF(max_lng - min_lng, 0)
      )::int)) AS gx,
      LEAST(4, GREATEST(0, FLOOR(
        5.0 * (ST_Y(cp.location::geometry) - min_lat) / NULLIF(max_lat - min_lat, 0)
      )::int)) AS gy
    FROM cuba_pois cp
    WHERE cp.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
      AND cp.is_active
      AND cp.category NOT IN ('highway','landuse','waterway','building',
                              'natural','barrier','place','man_made','railway')
      AND cp.importance <= CASE
        WHEN zoom_level >= 16 THEN 5    -- street level: every POI
        WHEN zoom_level >= 15 THEN 5    -- typical app zoom
        WHEN zoom_level >= 14 THEN 4
        WHEN zoom_level >= 12 THEN 3
        WHEN zoom_level >= 11 THEN 2    -- city overview: mid + top tier
        ELSE 1                          -- country/province overview (z<11) → top-tier only
      END
  ),
  ranked AS (
    -- Top-K per grid cell by (admin > importance > id deterministic tie).
    -- ROW_NUMBER over PARTITION BY (gx, gy) is the canonical SQL idiom
    -- for top-K-per-group queries.
    SELECT
      eligible.*,
      ROW_NUMBER() OVER (
        PARTITION BY gx, gy
        ORDER BY is_admin DESC, importance, id
      ) AS rk_in_cell
    FROM eligible
  )
  SELECT
    id, name, category, subcategory, tricigo_category,
    lat, lng, address, importance, is_admin
  FROM ranked
  WHERE rk_in_cell <= GREATEST(8, max_results / 25)
  -- Final global cap is still respected; the per-cell ranking just
  -- decides WHICH POIs fill the budget, ensuring periphery gets slots.
  ORDER BY is_admin DESC, importance, id
  LIMIT max_results;
$$;

COMMENT ON FUNCTION public.pois_in_viewport(
  double precision, double precision, double precision, double precision,
  integer, integer
) IS
  '00313: grid-based dispersion (top-K per 5×5 cell) on top of 00310 importance ceiling. Ensures periphery coverage when centre is saturated. Client-side companion: iconAllowOverlap+symbolSortKey in PoiMapLayers.tsx.';
