-- ============================================================
-- Migration 00314: search quality pass — re-categorize bus-stop noise
--                  + internal coord-cluster dedup in search_pois_smart
--
-- Bug the user reported on-device 2026-05-25 (continuation of PR #216):
-- Buscando "aeropuerto internacional" devuelve correctamente el HAV
-- como resultado #1 (id 192604), pero los siguientes 9 resultados son
-- ruido: "Gran Teatro de la Habana", "Hotel Presidente", "Hospital
-- Hijas De Galicia", paradas de bus, parques, etc. — todos taggeados
-- como `tricigo_category=transport` por la ingestión OSM.
--
-- Root cause: OSM tags `public_transport=platform/stop_position` se
-- importaron como `tricigo_category=transport`. Cuando el RPC detecta
-- "aeropuerto" como keyword de transport, devuelve TODO transport
-- incluyendo paradas mal nombradas.
--
-- Magnitud actual:
--   * platform   subcat: 580 rows active, solo 92 con hub-name legit
--   * stop_pos.  subcat: 365 rows active, solo 73 con hub-name legit
--   * station    subcat: 4 rows active, 4 legit (no se tocan)
-- Total a re-categorizar: ~945 rows → 780 efectivos (excluye admin +
-- excluye name con keyword hub real).
--
-- Y bug secundario observado: el HAV airport tiene 3 rows en cuba_pois
-- (id 192604/192610/192597), todas dentro de 10m, con nombres
-- ligeramente distintos ("Aeropuerto Internacional José Martí (HAV)",
-- "José Martí International Airport", "Aeropuerto de La Habana"). La
-- dedup de PR F (#212) sólo dedupea Google vs cuba_pois, NO dedupea
-- cuba_pois internamente.
--
-- Esta migración aplica DOS fixes:
--   Step 1: re-categoriza las ~780 rows ruidosas a `tricigo_category=
--           NULL`. Quedan findable por nombre (e.g. "Hotel Presidente"
--           sigue apareciendo si lo buscás por nombre), pero NO
--           matchean búsquedas por keyword de transport.
--   Step 2: agrega CTE de dedup interno al `search_pois_smart`. Bins
--           coord ~50m × 50m × categoría → ROW_NUMBER → keep top-1
--           por bin. El HAV airport colapsa de 3 → 1.
--
-- Reversible: Step 1 es UPDATE (puede revertirse seteando tricigo_
-- category de vuelta a 'transport'). Step 2 es CREATE OR REPLACE, se
-- puede volver a v3 reaplicando 00255 / la versión previa.
-- ============================================================

-- ── Step 1: re-categorize noisy bus-stop POIs ─────────────────
-- Set tricigo_category = NULL para platforms/stop_positions sin
-- nombre que indique hub real. Preserve admin-curated rows.

UPDATE cuba_pois
SET tricigo_category = NULL,
    updated_at = NOW()
WHERE is_active
  AND tricigo_category = 'transport'
  AND category = 'public_transport'
  AND subcategory IN ('platform', 'stop_position')
  AND NOT is_admin
  AND NOT (
    -- Preserve only rows with a real transport-hub keyword in the name.
    -- Cobertura conservadora: 'estacion'/'estación', 'terminal', 'aeropuerto',
    -- 'airport', 'puerto', 'port ', 'metro' (literal). Si el nombre es
    -- "Parque José Martí" o "Hotel Presidente" — NO match → re-categorize.
       lower(unaccent(name)) LIKE '%aeropuerto%'
    OR lower(unaccent(name)) LIKE '%airport%'
    OR lower(unaccent(name)) LIKE '%terminal%'
    OR lower(unaccent(name)) LIKE '%estacion%'
    OR lower(unaccent(name)) LIKE '%puerto%'
    OR lower(unaccent(name)) LIKE 'port %'
    OR lower(unaccent(name)) = 'port'
    OR lower(unaccent(name)) LIKE '%metro %'
    OR lower(unaccent(name)) = 'metro'
  );

-- ── Step 2: search_pois_smart with internal coord-cluster dedup ──
-- Wraps the existing `ranked` CTE with a `deduped` CTE that bins
-- POIs by ~50m × 50m grid + category, then ROW_NUMBER keeps the
-- best one per bin (by rank_quality > is_admin > confidence >
-- distance). Same final ORDER BY + LIMIT.

CREATE OR REPLACE FUNCTION public.search_pois_smart(
  query text,
  lat double precision DEFAULT 23.1136,
  lng double precision DEFAULT -82.3666,
  radius_m integer DEFAULT 50000,
  max_results integer DEFAULT 10
)
RETURNS TABLE(
  id bigint, name text, category text, subcategory text,
  tricigo_category text, address text, municipality text, province text,
  latitude double precision, longitude double precision,
  phone text, website text, source text, is_admin boolean, confidence real,
  distance_m double precision, matched_category text, match_reason text
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_norm TEXT;
  v_like TEXT;
  v_category TEXT;
  v_query_is_keyword BOOLEAN;
BEGIN
  v_norm := lower(unaccent(trim(query)));
  IF v_norm IS NULL OR length(v_norm) < 1 THEN RETURN; END IF;
  v_like := '%' || v_norm || '%';

  SELECT k.tricigo_category INTO v_category
  FROM cuba_search_keywords k
  WHERE v_norm = k.keyword OR v_norm LIKE k.keyword || ' %'
  ORDER BY length(k.keyword) DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM cuba_search_keywords k WHERE k.keyword = v_norm
  ) INTO v_query_is_keyword;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      p.id, p.name, p.category, p.subcategory, p.tricigo_category,
      COALESCE(p.address, '') AS address,
      COALESCE(p.municipality, p.city, '') AS municipality,
      COALESCE(p.province, '') AS province,
      ST_Y(p.location::geometry) AS latitude,
      ST_X(p.location::geometry) AS longitude,
      p.phone, p.website, p.source, p.is_admin, p.confidence,
      ST_Distance(
        p.location,
        ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
      ) AS distance_m,
      v_category AS matched_category,
      CASE
        WHEN p.name_normalized = v_norm THEN 'name_exact'
        WHEN p.name_normalized ILIKE v_norm || '%' THEN 'name_prefix'
        WHEN p.name_normalized ILIKE v_like OR p.name ILIKE v_like THEN 'name_substring'
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category THEN 'category_only'
        ELSE 'unknown'
      END AS match_reason,
      CASE
        WHEN v_query_is_keyword AND p.name_normalized = v_norm THEN 1
        ELSE 0
      END AS is_generic,
      CASE
        WHEN p.name_normalized = v_norm THEN 0
        WHEN p.name_normalized ILIKE v_norm || '%' THEN 1
        WHEN p.name_normalized ILIKE v_like OR p.name ILIKE v_like THEN 2
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category THEN 3
        ELSE 9
      END AS rank_quality
    FROM cuba_pois p
    WHERE p.is_active
      AND ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_m)
      AND p.category NOT IN (
        'highway', 'landuse', 'waterway', 'building', 'natural', 'barrier', 'place', 'man_made',
        'railway', 'river', 'lake', 'fountain'
      )
      AND NOT (p.category = 'amenity' AND p.subcategory IN ('telephone', 'drinking_water'))
      AND (
        p.name_normalized ILIKE v_like
        OR p.name ILIKE v_like
        OR (v_category IS NOT NULL AND p.tricigo_category = v_category)
      )
  ),
  -- 00314 — Internal dedup. Bins ~50m × 50m grid (0.0005° ≈ 55m at
  -- latitude 23°) + matched/tricigo category. ROW_NUMBER picks the
  -- best row per bin by ranking criteria, collapsing duplicates like
  -- the 3-entry HAV airport cluster.
  deduped AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY
          FLOOR(longitude * 2000)::int,
          FLOOR(latitude * 2000)::int,
          COALESCE(matched_category, tricigo_category, match_reason)
        ORDER BY
          rank_quality ASC,
          is_admin DESC,
          confidence DESC NULLS LAST,
          distance_m ASC
      ) AS coord_rk
    FROM ranked
  )
  SELECT
    d.id, d.name, d.category, d.subcategory, d.tricigo_category,
    d.address, d.municipality, d.province, d.latitude, d.longitude,
    d.phone, d.website, d.source, d.is_admin, d.confidence,
    d.distance_m, d.matched_category, d.match_reason
  FROM deduped d
  WHERE d.coord_rk = 1
  ORDER BY d.is_generic ASC,
           d.rank_quality ASC,
           d.is_admin DESC,
           d.confidence DESC NULLS LAST,
           d.distance_m ASC
  LIMIT max_results;
END;
$function$;

COMMENT ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) IS
  '00314: adds internal coord-cluster dedup (50m × 50m grid + category PARTITION) on top of the 00255 keyword-intent ranking. Collapses near-duplicate cuba_pois rows like the 3-entry HAV airport cluster. Step 1 of the same migration re-categorizes ~780 bus-stop platforms/stop_positions out of tricigo_category=transport so they no longer pollute category-keyword searches.';
