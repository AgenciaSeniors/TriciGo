-- ============================================================
-- POI viewport — progressive disclosure (Google-Maps style).
--
-- Supersedes the 00270 declutter. With `importance` now a real
-- prominence ranking (migration 00271), the viewport RPC reveals POIs
-- progressively: zoomed out → only the most prominent; as the user
-- zooms in → progressively more; fully zoomed in → ALL POIs in the
-- (now small) viewport.
--
-- Also adds `railway` to the excluded categories — ~1.9k rail-line
-- rows were leaking through as fake POIs.
--
-- Signature + columns unchanged → no client change needed.
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
    -- Exclude non-POI noise. `railway` added — rail lines were leaking.
    AND cp.category NOT IN ('highway','landuse','waterway','building',
                            'natural','barrier','place','man_made','railway')
    -- Progressive importance gate: only the most prominent when zoomed
    -- out, all importance levels once zoomed in.
    AND cp.importance <= CASE
      WHEN zoom_level >= 16 THEN 5
      WHEN zoom_level >= 15 THEN 4
      WHEN zoom_level >= 14 THEN 3
      WHEN zoom_level >= 12 THEN 2
      ELSE 1
    END
  ORDER BY cp.is_admin DESC, cp.importance, cp.id
  -- Progressive density cap. At z17+ the cap is effectively "all" — the
  -- viewport is so small that showing every POI is fine, not a blanket.
  LIMIT LEAST(max_results, CASE
      WHEN zoom_level >= 17 THEN 1500
      WHEN zoom_level >= 16 THEN 320
      WHEN zoom_level >= 15 THEN 160
      WHEN zoom_level >= 14 THEN 90
      WHEN zoom_level >= 13 THEN 55
      WHEN zoom_level >= 12 THEN 35
      ELSE 15
    END);
$function$;
