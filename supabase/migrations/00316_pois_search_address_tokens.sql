-- ============================================================
-- Migration 00316: search_pois_smart token-match against address
--
-- Bug verified on-device 2026-05-25: user types "hotel boutique 663"
-- looking for "El Hotel Boutique Malecón 663" (id 196569, address
-- "663 Malecón"). RPC returns category_only fallback list — the hotel
-- never surfaces. Root cause: 00315's matching uses a SINGLE
-- substring ILIKE on name/name_normalized only:
--
--   p.name_normalized ILIKE '%' || query || '%'
--   OR p.name ILIKE '%' || query || '%'
--
-- The full string "hotel boutique 663" is NOT a substring of
-- "El Hotel Boutique Malecón 663" because the word "Malecón" sits
-- between "Boutique" and "663". And the address field "663 Malecón"
-- is never read by the RPC at all.
--
-- Fix in 3 coordinated steps (all reversible by re-applying 00315):
--
--   A) Add `address_normalized` column + BEFORE trigger that keeps it
--      in sync (mirror of the existing name_normalized pattern), and
--      backfill ~200k existing rows.
--   B) Create GIN trigram index on address_normalized so the new
--      per-token ILIKE substring scans use the index instead of
--      table-scanning (mirror of idx_cuba_pois_name_trgm from 00106).
--   C) Re-create search_pois_smart with token-based matching:
--      tokenize the query by whitespace (filtering tokens <2 chars),
--      then require EVERY token to appear in either name_normalized
--      OR address_normalized. Adds a new match_reason value
--      'name_address_tokens' ranked between 'name_substring' and
--      'category_only' so the existing UI ordering stays intuitive.
--
-- The RPC signature, return columns, and existing behaviour are all
-- preserved — apps don't need code changes. Queries that worked
-- before (like the full "hotel boutique malecon 663" matching as
-- name_substring) keep returning identical top results.
--
-- Performance: the per-row NOT EXISTS over unnest(tokens) is the
-- new hot path. Each ILIKE '%token%' uses its respective trigram
-- index (name_normalized via 00106's idx, address_normalized via
-- the new idx in Step B). Postgres can plan NOT EXISTS as an
-- anti-join. EXPLAIN ANALYZE in pre-apply test should show
-- BitmapIndexScan on both trigram indexes and total RPC <100ms.
-- ============================================================

-- ── Step A: address_normalized column + backfill + trigger ──────

ALTER TABLE public.cuba_pois
  ADD COLUMN IF NOT EXISTS address_normalized TEXT;

-- One-time backfill. Idempotent: only writes rows where source has
-- a value AND normalized is still NULL. Re-running the migration
-- after a partial failure simply continues where it left off.
UPDATE public.cuba_pois
SET address_normalized = lower(unaccent(address))
WHERE address IS NOT NULL
  AND address <> ''
  AND address_normalized IS NULL;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_set_address_normalized()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.address_normalized := CASE
    WHEN NEW.address IS NULL OR NEW.address = '' THEN NULL
    ELSE lower(unaccent(NEW.address))
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cuba_pois_address_normalized_trg ON public.cuba_pois;
CREATE TRIGGER cuba_pois_address_normalized_trg
  BEFORE INSERT OR UPDATE OF address ON public.cuba_pois
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_cuba_pois_set_address_normalized();

-- ── Step B: GIN trigram index on address_normalized ─────────────

-- Note: NOT using CONCURRENTLY because Supabase migrations run inside
-- a transaction by default and CONCURRENTLY is incompatible with that.
-- The index build takes 1-3 min on ~200k rows; cuba_pois only receives
-- writes from the weekly sync job, so a brief AccessExclusiveLock is
-- safe at any time. Documented in plan as "coordinate with low-traffic
-- moment" but in practice this table is essentially read-only.
CREATE INDEX IF NOT EXISTS idx_cuba_pois_address_trgm
  ON public.cuba_pois USING gin (address_normalized gin_trgm_ops)
  WHERE address_normalized IS NOT NULL;

-- ── Step C: re-create search_pois_smart with token matching ─────

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

  -- 00316 — tokenize for multi-word AND matching against name+address.
  -- Filter out tokens <2 chars to avoid noise from connectors like "y",
  -- "e", numeric punctuation. Single-token queries (no spaces) still
  -- exercise this path via array of length 1 — net zero behaviour
  -- change since name_substring already covers them.
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
        -- 00316: new tier — all tokens matched against name+address combined
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
      -- 00316: rank_quality bumped to NUMERIC to allow the new
      -- 2.5 tier between name_substring (2) and category_only (3).
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
        -- 00316: include POIs where every query token matches in
        -- name OR address (per-token, not concatenated, so trigram
        -- indexes apply to each ILIKE).
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
  -- Internal dedup unchanged from 00315: bin width 0.001° (~110m)
  -- + qualified r.* references to avoid is_admin ambiguity.
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
  ORDER BY d.is_generic ASC,
           d.rank_quality ASC,
           d.is_admin DESC,
           d.confidence DESC NULLS LAST,
           d.distance_m ASC
  LIMIT max_results;
END;
$function$;

COMMENT ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) IS
  '00316: token-based matching against name + address. Tokenize query by whitespace, require every token (>=2 chars) to appear in name_normalized OR address_normalized. New match_reason value name_address_tokens at rank_quality 2.5 (between name_substring and category_only). Fixes "hotel boutique 663" → "El Hotel Boutique Malecón 663" surfacing without requiring the user to type "malecón".';

COMMENT ON COLUMN public.cuba_pois.address_normalized IS
  '00316: lower(unaccent(address)) maintained by tg_cuba_pois_set_address_normalized trigger. Backed by GIN trigram index idx_cuba_pois_address_trgm. Used by search_pois_smart for per-token ILIKE matching.';
