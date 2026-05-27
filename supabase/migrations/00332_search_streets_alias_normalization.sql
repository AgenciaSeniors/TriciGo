-- ============================================================
-- Migration 00332: search_streets v5 — alias normalization
--
-- WHY:
--   OSM stores many Cuban streets with both their modern official name
--   and historical/popular alias in parentheses:
--
--     "Padre Varela (Belascoaín)"        ← user types "Belascoaín"
--     "Avenida Simón Bolívar (Reina)"    ← user types "Reina"
--     "Avenida de los Presidentes (Calle G)"
--     "Avenida Salvador Allende (Carlos III)"
--     "27 de Noviembre (Jovellar)"
--     "Calzada (7ma)"
--     "Calle 23 (La Rampa)"
--
--   Cubans almost always use the historical/popular alias (the part in
--   parentheses). Today the dropdown shows the OFFICIAL name as primary,
--   which is confusing — the user searches "Belascoaín" and sees "Padre
--   Varela" as the label.
--
--   Also: OSM has duplicate rows for the same street with minor
--   orthographic variation ("Ampliacion" vs "Ampliación"). After 00331's
--   dedup by main_street, these are still separate rows because the
--   strings differ. With `unaccent` we can collapse them too.
--
-- WHAT THIS DOES:
--   1. Helper `_street_display_name(text)` — extracts the alias in
--      parentheses when present, else returns the original.
--   2. Helper `_street_normalize_key(text)` — LOWER + unaccent on the
--      display name for canonical dedup.
--   3. search_streets DISTINCT ON normalized key → collapses accent and
--      case variants of the same street into one row.
--   4. The returned `name` field shows the user-friendly alias first.
--   5. The returned `address` field shows both names when an alias
--      exists: "Belascoaín (Padre Varela) e/ San Lázaro" — so the user
--      can verify it's the right street.
--
-- WHAT STAYS:
--   - Same shape (name, address, latitude, longitude, municipality,
--     province, distance_m). Frontend reads the same fields.
--   - Same trigram tolerance, wildcard escape, proximity buckets.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Extension (idempotent)
-- ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS unaccent;


-- ─────────────────────────────────────────────────────────────────
-- Helper: extract display name (prefer the alias in parentheses)
-- ─────────────────────────────────────────────────────────────────
--
-- Examples:
--   "Padre Varela (Belascoaín)"   → "Belascoaín"
--   "Calle 23 (La Rampa)"         → "La Rampa"
--   "Calle 23"                    → "Calle 23"      (no alias)
--   "Anything (X) (Y)"            → "Y"             (last paren wins)
--   ""                            → ""              (defensive)

CREATE OR REPLACE FUNCTION public._street_display_name(s TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN
      trim(regexp_replace(s, '^.+\s+\(([^)]+)\)\s*$', '\1'))
    ELSE s
  END;
$$;

COMMENT ON FUNCTION public._street_display_name IS
  '00332 - Returns the parenthesized alias of a street name when present (the popular Cuban form), else the original. Helper for search_streets display.';


-- ─────────────────────────────────────────────────────────────────
-- Helper: normalized key for dedup (accent + case insensitive)
-- ─────────────────────────────────────────────────────────────────
--
-- Examples:
--   "Ampliacion"   → "ampliacion"
--   "Ampliación"   → "ampliacion"   (unaccent strips the accent)
--   "BELASCOAÍN"   → "belascoain"

CREATE OR REPLACE FUNCTION public._street_normalize_key(s TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(unaccent(coalesce(s, '')));
$$;

COMMENT ON FUNCTION public._street_normalize_key IS
  '00332 - Lowercase + accent-stripped normalization for DISTINCT keys. Collapses "Ampliación" / "Ampliacion" / "AMPLIACIÓN" into one bucket.';


-- ─────────────────────────────────────────────────────────────────
-- search_streets v5
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_streets(
  query        TEXT,
  lat          DOUBLE PRECISION DEFAULT 23.1136,
  lng          DOUBLE PRECISION DEFAULT -82.3666,
  max_results  INTEGER          DEFAULT 10
)
RETURNS TABLE(
  name          TEXT,
  address       TEXT,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  municipality  TEXT,
  province      TEXT,
  distance_m    DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_user_point  GEOGRAPHY(POINT, 4326);
  v_norm_query  TEXT;
  v_escaped     TEXT;
  v_limit       INTEGER;
BEGIN
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_norm_query := trim(query);
  v_escaped := replace(replace(replace(v_norm_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);

  RETURN QUERY
  WITH matches AS (
    -- DISTINCT ON normalized display key. "Padre Varela (Belascoaín)"
    -- (display: Belascoaín) and "Belascoaín" (display: Belascoaín)
    -- collapse into one row. "Ampliacion" and "Ampliación" too.
    SELECT DISTINCT ON (public._street_normalize_key(public._street_display_name(si.main_street)))
      si.main_street AS raw_name,
      public._street_display_name(si.main_street) AS display_name,
      si.cross_street_1,
      si.municipality,
      si.province,
      si.intersection_point,
      ST_Distance(si.intersection_point, v_user_point) AS dist,
      -- Match-quality ranking against the original main_street AND the
      -- extracted display name — so searching "Belascoaín" hits both
      -- "Belascoaín" (display) and "Padre Varela (Belascoaín)" (raw).
      LEAST(
        CASE
          WHEN si.main_street ILIKE v_escaped THEN 0
          WHEN si.main_street ILIKE v_escaped || '%' THEN 1
          WHEN si.main_street ILIKE '% ' || v_escaped || '%' THEN 2
          WHEN si.main_street ILIKE '%' || v_escaped || '%' THEN 3
          ELSE 4
        END,
        CASE
          WHEN public._street_display_name(si.main_street) ILIKE v_escaped THEN 0
          WHEN public._street_display_name(si.main_street) ILIKE v_escaped || '%' THEN 1
          WHEN public._street_display_name(si.main_street) ILIKE '% ' || v_escaped || '%' THEN 2
          WHEN public._street_display_name(si.main_street) ILIKE '%' || v_escaped || '%' THEN 3
          ELSE 4
        END
      ) AS match_rank
    FROM public.street_intersections si
    WHERE si.main_street ILIKE '%' || v_escaped || '%'
       OR public._street_display_name(si.main_street) ILIKE '%' || v_escaped || '%'
       OR similarity(si.main_street, v_norm_query) > 0.30
       OR similarity(public._street_display_name(si.main_street), v_norm_query) > 0.30
    ORDER BY
      public._street_normalize_key(public._street_display_name(si.main_street)),
      ST_Distance(si.intersection_point, v_user_point) ASC
  )
  SELECT
    -- Display name: the popular alias when present, else the raw name
    m.display_name AS name,
    -- Address: include both forms when alias exists, so user can verify
    -- "Belascoaín (Padre Varela) e/ San Lázaro"
    CASE
      WHEN m.raw_name <> m.display_name THEN
        m.display_name
          || ' (' || trim(regexp_replace(m.raw_name, '^(.+)\s+\([^)]+\)\s*$', '\1')) || ')'
          || COALESCE(' e/ ' || m.cross_street_1, '')
      ELSE
        m.raw_name || COALESCE(' e/ ' || m.cross_street_1, '')
    END AS address,
    ST_Y(m.intersection_point::geometry) AS latitude,
    ST_X(m.intersection_point::geometry) AS longitude,
    COALESCE(m.municipality, '') AS municipality,
    COALESCE(m.province, '') AS province,
    m.dist AS distance_m
  FROM matches m
  ORDER BY
    -- Proximity buckets (from 00330)
    CASE
      WHEN m.dist <= 25000  THEN 0
      WHEN m.dist <= 100000 THEN 1
      WHEN m.dist <= 300000 THEN 2
      ELSE 3
    END,
    m.match_rank,
    m.dist
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.search_streets IS
  '00332 v5 - Alias normalization: prefers Cuban popular alias from parentheses ("Padre Varela (Belascoaín)" displayed as "Belascoaín"). Dedups accent/case variants via _street_normalize_key. Address line shows both names for user verification.';
