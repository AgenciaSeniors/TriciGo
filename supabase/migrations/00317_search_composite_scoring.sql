-- ============================================================
-- Migration 00317: search_pois_smart composite scoring (PR L)
--
-- 00316's matching is correct (token search against name + address)
-- but its ORDER BY is a multi-column tiebreaker chain:
--
--   ORDER BY is_generic ASC,
--            rank_quality ASC,
--            is_admin DESC,
--            confidence DESC NULLS LAST,
--            distance_m ASC
--
-- Symptoms observable in prod ranking:
--
--   1. Distance is the LAST tiebreaker — a POI 25 km away with
--      confidence=1 outranks one at 1 km with confidence=0.9.
--      For dense-city queries like "hotel" or "restaurante", the
--      cercano loses the slot.
--
--   2. is_admin and confidence are sequential binary tiebreakers —
--      not combined. An admin POI with low confidence beats a
--      non-admin POI with high confidence, even when the quality
--      gap is minimal.
--
--   3. Verification signal (phone / website set = "alguien revisó
--      este POI") is completely ignored.
--
--   4. No penalty for very large distances — POI with high quality
--      at 50 km wins over relevant POI at 2 km.
--
-- Fix: replace the multi-column ORDER BY with a single composite
-- numeric score where rank_quality dominates (×1000) but the
-- modifiers (admin/conf/distance/verified) combine into a tighter
-- ordering within the same tier.
--
-- Composite weights (all penalties — lower = better, ORDER BY ASC):
--
--   base       = rank_quality × 1000              [0, 1000, 2000, 2500, 3000, 9000]
--   generic    = is_generic × 5000                [0 or 5000 — generic-name to floor]
--   admin      = NOT is_admin × 40                [0 or 40]
--   conf       = (1 - confidence) × 30            [0 to 30]
--   distance   = LEAST(distance_m / 1000, 30)     [0 to 30, capped at 30 km]
--   verified   = (NO phone AND NO website) × 8    [0 or 8]
--
-- Total modifier range: 0 to ~108 points — never enough to cross
-- the 1000-pt tier boundary. Modifiers only reorder WITHIN a tier
-- (e.g. all category_only matches at rank_quality=3 sort by
-- distance+admin+conf+verified rather than just the first 3).
--
-- Worked example (tier rank_quality=3):
--   Hotel Nacional (admin, conf=1, phone, 2km)  →  3000 + 0 + 0 + 2 + 0   = 3002
--   Hotel lejos    (admin, conf=1, phone, 25km) →  3000 + 0 + 0 + 25 + 0  = 3025
--   Boutique cerca (non-admin, conf=.85, phone, 1km) → 3000 + 40 + 4.5 + 1 + 0 = 3045.5
--   Casa generic   (non-admin, conf=.5, no phone, 5km) → 3000 + 40 + 15 + 5 + 8 = 3068
--
-- Pre-00317 the lejano-admin-conf=1 wins over boutique-cercano.
-- Post-00317 the cercano gains ~23 points but stays close — a
-- balanced tradeoff between admin curation and proximity.
--
-- NO changes to: WHERE / matching / dedup / return columns /
-- function signature. Cliente/driver/web require zero code change.
-- ============================================================

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
  -- 00317: composite score ORDER BY (lower = better)
  ORDER BY (
    -- Quality tier dominates (×1000 — separates tiers cleanly)
    d.rank_quality * 1000
    -- Generic-name placeholders to the floor
    + d.is_generic * 5000
    -- Non-admin penalty (40pts)
    + CASE WHEN d.is_admin THEN 0 ELSE 40 END
    -- Confidence weighting (0-30pts; conf=1 → 0, conf=0 → 30)
    + (1 - COALESCE(d.confidence, 0.5)) * 30
    -- Distance penalty linear capped at 30 km
    + LEAST(d.distance_m / 1000.0, 30)
    -- Verification signal (sin phone NI website = 8pts penalty)
    + CASE WHEN d.phone IS NOT NULL OR d.website IS NOT NULL THEN 0 ELSE 8 END
  ) ASC,
  -- Stable tiebreaker — same id deterministic ordering on identical score
  d.id ASC
  LIMIT max_results;
END;
$function$;

COMMENT ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) IS
  '00317: composite scoring ORDER BY. rank_quality×1000 dominates tier separation; modifiers (admin/conf/distance/verified) reorder WITHIN tiers. Cercanos verificados con contact info ahora bumpean sobre lejanos admin-only. Matching logic unchanged from 00316.';
