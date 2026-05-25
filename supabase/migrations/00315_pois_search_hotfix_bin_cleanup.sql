-- ============================================================
-- Migration 00315: search_pois_smart hotfix + bin bump + targeted cleanup
--
-- Tres fixes consolidados en una migración, todos respuesta al testing
-- on-device 2026-05-25 que reveló problemas inmediatos post-00314:
--
-- A) HOTFIX: 00314 introdujo una ambigüedad de "is_admin" cuando el
--    window function de la CTE `deduped` referenciaba columnas bare.
--    Postgres confundió la columna de `ranked` con el OUT-param del
--    RETURNS TABLE. Resultado: search_pois_smart() devolvía ERROR
--    42702 para CUALQUIER query. App de cliente roto.
--    Fix: aliasar `FROM ranked r` y qualificar todas las references
--    con `r.*` dentro del window function.
--
-- B) BIN BUMP: 00314 usó bin width de 0.0005° (~55m) para la dedup
--    interna de coords. Insuficiente: los 3 entries del HAV airport
--    están a ~25m / ~55m de separación → 2 quedaron en bins distintos
--    y sobrevivieron al dedup. Bump a 0.001° (~110m) atrapa cluster
--    más amplio sin colapsar POIs verdaderamente distintos (PARTITION
--    BY category sigue protegiendo restaurant+farmacia a 80m).
--
-- C) CLEANUP DIRIGIDO: 15 rows ruidosos identificados manualmente —
--    teatros/hoteles/casas/empresas/bares mal taggeados como transport
--    (algunos admin-curated, otros desde Foursquare/Overture sync).
--    Re-categorizar a 'other' (trigger convierte NULL→'other' anyway).
--
--    IDs admin-curated (los 4 que sobrevivieron al Step 1 de 00314
--    porque excluía is_admin=true):
--      66397  Gran Teatro de la Habana   → public_transport/platform
--      71115  Hotel Melia Cohiba         → public_transport/platform
--      71136  Hotel Presidente           → public_transport/platform
--      68689  Rancho San Vicente         → public_transport/platform
--
--    IDs non-admin con name-prefix obvio que NO es transport:
--      210484 Bar Restaurante Las Palmas (Foursquare "Rest Area")
--      207859 Casa Confort Erga          (Overture "tours")
--      198702 Casa Edel en Viñales       (Overture "tours")
--      196936 Casa Havana Senses         (Overture "tours")
--      195901 Casa parrondo en el callejon de hamel (Overture "tours")
--      122797 Hotel Panorama             (amenity/car_rental)
--      71127  Hotel Panorama             (amenity/car_rental, duplicate)
--      213602 Rancho "El Dajao"          (Overture "tours")
--
--    IDs non-airport pero category='airport' literal (OSM/Overture quirks):
--      195094 H&M Bar Cuba               (es un bar!)
--      207701 Avship                     (entidad no identificada)
--      192529 Empresa Cubana de Aeropuertos y Servicios Aeroportuarios S.A.
--             (empresa, no aeropuerto físico)
--
-- Reversible: Step C es UPDATE selectivo por ID (puede reset).
-- Steps A, B son CREATE OR REPLACE (puede re-aplicar versión anterior).
-- ============================================================

-- ── Step C: re-categorize 15 noise IDs to 'other' ───────────────
-- Hago primero para asegurar el cleanup antes del reemplazo del RPC,
-- así si algo falla en step A/B el cleanup ya quedó (idempotente).
UPDATE cuba_pois
SET tricigo_category = 'other',
    updated_at = NOW()
WHERE id IN (
  -- Admin-curated public_transport/platform de landmarks
  66397, 71115, 71136, 68689,
  -- Non-admin con name-prefix wrong category
  210484, 207859, 198702, 196936, 195901, 122797, 71127, 213602,
  -- Non-airport tagged category='airport'
  195094, 207701, 192529
)
AND tricigo_category = 'transport'
AND is_active;

-- ── Steps A + B: search_pois_smart fix + bin bump ───────────────
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
  -- 00315 — Internal dedup con bin width 0.001° (~110m) y refs r.*
  -- qualified para evitar ambiguity con RETURNS TABLE OUT-params.
  deduped AS (
    SELECT r.*,
      ROW_NUMBER() OVER (
        PARTITION BY
          FLOOR(r.longitude * 1000)::int,                            -- 00315: bin 0.001° ≈ 110m (was 0.0005° in 00314)
          FLOOR(r.latitude * 1000)::int,
          COALESCE(r.matched_category, r.tricigo_category, r.match_reason)
        ORDER BY
          r.rank_quality ASC,
          r.is_admin DESC,
          r.confidence DESC NULLS LAST,
          r.distance_m ASC
      ) AS coord_rk
    FROM ranked r
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
  '00315: HOTFIX para 00314 (is_admin ambiguous fix) + bump dedup bin 0.0005°→0.001° (atrapa HAV cluster completo) + targeted UPDATE de 15 noise IDs identificados manualmente.';
