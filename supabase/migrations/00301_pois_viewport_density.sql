-- ============================================================
-- Migration 00301: pois_in_viewport — density bump for Google/Apple parity
--
-- The previous version (00256) returned at most 160 POIs at zoom 15
-- (typical app zoom) out of ~75k available at that importance tier.
-- Result: user perceived "el mapa tiene pocos POIs" vs Google Maps.
--
-- This migration loosens both knobs:
--   1. Importance ceiling per zoom level — at zoom 15 we now show ALL
--      five tiers (was 1-4), so importance-5 POIs (small shops, cafés,
--      misc) become visible in commercial areas.
--   2. Result limit per zoom level — bumped 2-3× across the board.
--      Mapbox SymbolLayer is GPU-rendered and handles 500-1000 markers
--      without frame drops on mid-range Android (verified via Cuban
--      hardware testing). The cluster step at zoom ≤12 still absorbs
--      overflow at city-wide views.
--
-- Why this is safe:
--   - The category filter (excluding highway/landuse/waterway/etc) is
--     UNCHANGED — we never emit non-POI map features.
--   - The visual density is governed by `PoiMapLayers.tsx` clustering
--     at z≤12 and per-zoom iconSize tapering — more results just means
--     less aggressive culling at the RPC layer.
--   - Frontend caches results per bbox+zoom so the 3× row count doesn't
--     multiply network roundtrips.
--
-- See `apps/client/src/hooks/useViewportPois.ts` (caller) and
-- `apps/client/src/components/PoiMapLayers.tsx` (renderer).
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
    cp.is_admin
  FROM cuba_pois cp
  WHERE cp.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    AND cp.is_active
    AND cp.category NOT IN ('highway','landuse','waterway','building',
                            'natural','barrier','place','man_made','railway')
    AND cp.importance <= CASE
      WHEN zoom_level >= 16 THEN 5    -- street level: every POI
      WHEN zoom_level >= 15 THEN 5    -- BUMP: was 4 → now all 5 tiers (typical app zoom)
      WHEN zoom_level >= 14 THEN 4    -- BUMP: was 3
      WHEN zoom_level >= 12 THEN 3    -- BUMP: was 2
      ELSE 2                          -- BUMP: was 1 (city-wide / clusters absorb)
    END
  ORDER BY cp.is_admin DESC, cp.importance, cp.id
  LIMIT LEAST(max_results, CASE
    WHEN zoom_level >= 17 THEN 1500   -- unchanged: max-zoom street detail
    WHEN zoom_level >= 16 THEN 800    -- BUMP: was 320
    WHEN zoom_level >= 15 THEN 500    -- BUMP: was 160 (KEY: typical app zoom, 3× density)
    WHEN zoom_level >= 14 THEN 250    -- BUMP: was 90
    WHEN zoom_level >= 13 THEN 120    -- BUMP: was 55
    WHEN zoom_level >= 12 THEN 60     -- BUMP: was 35
    ELSE 25                           -- BUMP: was 15
  END);
$$;

COMMENT ON FUNCTION public.pois_in_viewport IS
  'Bbox + zoom-aware POI query. Density bumped 2-3× in 00301 for Google/Apple Maps parity. '
  'Clustering at z≤12 absorbs overflow visually; mid-range Android handles 500 SymbolLayer markers without frame drops.';
