-- ============================================================
-- POI viewport declutter — stop blanketing the map.
--
-- pois_in_viewport filtered by `importance` per zoom but then returned
-- up to 1500 rows with no real density cap. In central Havana a z14
-- viewport has hundreds of importance≤4 POIs → all rendered → the map
-- was a blanket of colored dots.
--
-- Fix: (1) tighten the importance gate one zoom step, and (2) add a
-- real per-zoom row cap. Ordering stays `is_admin DESC, importance, id`
-- so the cap keeps the MOST PROMINENT POIs (admin-curated first, then
-- by importance). At z14 (typical ride-booking zoom): importance ≤3
-- + cap 30 → ~25-30 prominent POIs instead of a blanket.
--
-- Signature + columns unchanged — the client (geo.ts fetchPoisInViewport,
-- still sending max_results: 1500) needs no change; LEAST() clamps it.
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
  id bigint, name text, category text, subcategory text,
  tricigo_category text, lat double precision, lng double precision,
  address text, importance smallint, is_admin boolean
)
LANGUAGE sql
STABLE
AS $function$
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
                            'natural','barrier','place','man_made')
    -- Importance gate, tightened one zoom step vs the old version so
    -- the bulk (importance 4-5, ~92k POIs) only appears zoomed in.
    AND cp.importance <= CASE
      WHEN zoom_level >= 16 THEN 5
      WHEN zoom_level >= 15 THEN 4
      WHEN zoom_level >= 14 THEN 3
      WHEN zoom_level >= 13 THEN 2
      ELSE 1
    END
  ORDER BY cp.is_admin DESC, cp.importance, cp.id
  -- Hard per-zoom density cap (the real declutter). The ORDER BY above
  -- means the cap keeps the most prominent POIs.
  LIMIT LEAST(max_results, CASE
      WHEN zoom_level >= 17 THEN 300
      WHEN zoom_level >= 16 THEN 150
      WHEN zoom_level >= 15 THEN 70
      WHEN zoom_level >= 14 THEN 30
      WHEN zoom_level >= 13 THEN 20
      ELSE 12
    END);
$function$;
