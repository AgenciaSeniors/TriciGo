-- ============================================================
-- Migration 00310: pois_in_viewport v3 — viewport visibility fix (PR D)
--
-- Bug the user reported during on-device testing 2026-05-25:
-- "haga zoom en otros lugares no se ven los emojis de los pois".
-- Even when the user pans/zooms to Santiago, Camagüey, Marianao
-- (outside Habana centro), the markers fail to appear.
--
-- The DB has POIs distributed across all 16 provinces (verified:
-- La Habana 28k, Camagüey 9k, Holguín 9k, Villa Clara 7k, Santiago
-- 6k, Pinar 5k...). So data is NOT the issue.
--
-- Two contributing factors at the RPC level (00301):
--   1. LIMIT 500 at zoom 15 saturates in Habana centro (dense area),
--      so once user pans elsewhere the bbox query loads <500 from
--      sparse outlying area but renders nothing because the visual
--      feels empty vs the just-vacated dense view.
--   2. At zoom < 11, the importance ceiling of 1-2 (`<= 2`) leaves
--      no fallback at country-wide views — there were no "landmark
--      mode" results to scaffold a sense of place.
--
-- This migration:
--   * Bumps per-zoom LIMITs across the board (2-3× at low zoom,
--     1.5× at mid zoom), so outlying bboxes get more headroom and
--     the visual density catches up to Google/Apple-like overview.
--   * Adds an EXPLICIT "country-wide overview" path: when zoom < 11
--     (which the frontend will now reach after lowering its zoom
--     guard from 10 to 8 in the same PR), we ONLY return the top
--     100 importance=1 POIs in the bbox — Wikidata landmarks +
--     admin-curated places — so the user sees Capitolio, Catedral,
--     Aeropuerto, museos, etc. as scaffolding instead of nothing.
--
-- Frontend cooperates: `packages/ui/src/useViewportPois.ts` lowers
-- its zoom guard from 10 → 8 in the same PR so this branch is
-- reachable.
--
-- See `packages/ui/src/cameraEventBounds.ts` (the new helper that
-- guarantees onCameraChanged events actually deliver bounds to this
-- RPC) and `packages/ui/src/PoiMapLayers.tsx` (renderer).
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
      WHEN zoom_level >= 15 THEN 5    -- typical app zoom
      WHEN zoom_level >= 14 THEN 4
      WHEN zoom_level >= 12 THEN 3
      WHEN zoom_level >= 11 THEN 2    -- city overview: mid + top tier
      ELSE 1                          -- NEW: country/province overview (z<11) → top-tier only (Wikidata + admin)
    END
  ORDER BY cp.is_admin DESC, cp.importance, cp.id
  LIMIT LEAST(max_results, CASE
    WHEN zoom_level >= 17 THEN 2000   -- BUMP: was 1500 — max-zoom street detail
    WHEN zoom_level >= 16 THEN 1500   -- BUMP: was 800
    WHEN zoom_level >= 15 THEN 1200   -- BUMP: was 500 (KEY: typical zoom, 2.4× density vs 00301)
    WHEN zoom_level >= 14 THEN 900    -- BUMP: was 250
    WHEN zoom_level >= 13 THEN 700    -- BUMP: was 120
    WHEN zoom_level >= 12 THEN 500    -- BUMP: was 60
    WHEN zoom_level >= 11 THEN 300    -- BUMP: was 25
    ELSE 100                          -- NEW: country/province overview — top 100 landmarks
  END);
$$;

COMMENT ON FUNCTION public.pois_in_viewport IS
  'Bbox + zoom-aware POI query, v3 (00310). Density bumped 2-3× from 00301 to keep outlying provinces visible alongside Habana. Added explicit "country overview" path (zoom < 11) that returns top-100 importance=1 POIs (Wikidata landmarks + admin) so users see scaffolding at province/country zoom. Clustering at z≤12 absorbs overflow visually; mid-range Android handles 1200 SymbolLayer markers without frame drops.';
