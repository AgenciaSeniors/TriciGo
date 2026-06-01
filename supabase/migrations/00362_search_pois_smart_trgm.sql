-- ============================================================
-- Migration 00362: typo-tolerant POI name search
--
-- WHY:
--   search_pois_smart matched POI names with unaccent + ILIKE substring/token
--   only — no trigram — so a real typo missed entirely (unlike search_streets).
--   Verified vs prod: search_pois_smart('capitlio') → 0, while
--   similarity(name_normalized,'capitlio') > 0.3 finds "El Capitolio" (0.467),
--   "Capitolio Km 0" (0.412), etc.
--
-- WHAT THIS DOES (signature + body otherwise identical — CREATE OR REPLACE):
--   Adds a pg_trgm fuzzy branch (similarity(p.name_normalized, v_norm) > 0.3)
--   to the name-match WHERE, plus a 'name_fuzzy' match_reason and a
--   rank_quality of 2.8 (below token matches, above category-only) so a fuzzy
--   name hit ranks as a real—if weaker—name match. pg_trgm + unaccent are
--   already used elsewhere (search_streets v6); search_path already includes
--   'extensions'.
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_pois_smart(
  query       text,
  lat         double precision DEFAULT 23.1136,
  lng         double precision DEFAULT -82.3666,
  radius_m    integer          DEFAULT 50000,
  max_results integer          DEFAULT 10
)
RETURNS TABLE(
  id bigint, name text, category text, subcategory text, tricigo_category text,
  address text, municipality text, province text, latitude double precision,
  longitude double precision, phone text, website text, source text,
  is_admin boolean, confidence real, distance_m double precision,
  matched_category text, match_reason text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_norm TEXT;
  v_like TEXT;
  v_category TEXT;
  v_query_is_keyword BOOLEAN;
  v_tokens TEXT[];
  v_token_count INT;
BEGIN
  v_norm := lower(unaccent(trim(query)));
  IF v_norm IS NULL OR length(v_norm) < 1 THEN RETURN; END IF;
  v_like := '%' || v_norm || '%';

  v_tokens := ARRAY(
    SELECT t FROM unnest(string_to_array(v_norm, ' ')) AS t
    WHERE length(t) >= 2
  );
  v_token_count := COALESCE(array_length(v_tokens, 1), 0);

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
        WHEN v_token_count > 0
             AND NOT EXISTS (
               SELECT 1 FROM unnest(v_tokens) AS t
               WHERE NOT (
                 p.name_normalized ILIKE '%' || t || '%'
                 OR COALESCE(p.address_normalized, '') ILIKE '%' || t || '%'
               )
             )
        THEN 'name_address_tokens'
        WHEN similarity(p.name_normalized, v_norm) > 0.3 THEN 'name_fuzzy'
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category THEN 'category_only'
        ELSE 'unknown'
      END AS match_reason,
      CASE
        WHEN v_query_is_keyword AND p.name_normalized = v_norm THEN 1
        ELSE 0
      END AS is_generic,
      CASE
        WHEN p.name_normalized = v_norm THEN 0::numeric
        WHEN p.name_normalized ILIKE v_norm || '%' THEN 1::numeric
        WHEN p.name_normalized ILIKE v_like OR p.name ILIKE v_like THEN 2::numeric
        WHEN v_token_count > 0
             AND NOT EXISTS (
               SELECT 1 FROM unnest(v_tokens) AS t
               WHERE NOT (
                 p.name_normalized ILIKE '%' || t || '%'
                 OR COALESCE(p.address_normalized, '') ILIKE '%' || t || '%'
               )
             )
        THEN 2.5::numeric
        WHEN similarity(p.name_normalized, v_norm) > 0.3 THEN 2.8::numeric
        WHEN v_category IS NOT NULL AND p.tricigo_category = v_category THEN 3::numeric
        ELSE 9::numeric
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
        OR (
          v_token_count > 0
          AND NOT EXISTS (
            SELECT 1 FROM unnest(v_tokens) AS t
            WHERE NOT (
              p.name_normalized ILIKE '%' || t || '%'
              OR COALESCE(p.address_normalized, '') ILIKE '%' || t || '%'
            )
          )
        )
        OR similarity(p.name_normalized, v_norm) > 0.3
        OR (v_category IS NOT NULL AND p.tricigo_category = v_category)
      )
  ),
  deduped AS (
    SELECT r.*,
      ROW_NUMBER() OVER (
        PARTITION BY
          FLOOR(r.longitude * 1000)::int,
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
  ORDER BY (
    d.rank_quality * 1000
    + d.is_generic * 5000
    + CASE WHEN d.is_admin THEN 0 ELSE 40 END
    + (1 - COALESCE(d.confidence, 0.5)) * 30
    + LEAST(d.distance_m / 1000.0, 30)
    + CASE WHEN d.phone IS NOT NULL OR d.website IS NOT NULL THEN 0 ELSE 8 END
  ) ASC,
  d.id ASC
  LIMIT max_results;
END;
$function$;

COMMENT ON FUNCTION public.search_pois_smart IS
  '00362 - POI smart search; adds pg_trgm fuzzy name matching (name_fuzzy / rank_quality 2.8) on top of unaccent + ILIKE substring/token + category detection.';
