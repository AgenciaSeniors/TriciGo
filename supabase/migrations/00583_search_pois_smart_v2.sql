-- ============================================================================
-- 00583 — search_pois_smart v2 + reverse-geocode label from display_name
--
-- Spec: docs/superpowers/specs/2026-09-05-poi-quality-design.md §5.1
-- Plan: docs/superpowers/plans/2026-09-06-poi-quality-pr2-search.md
-- Depends on 00579 (poi_search_names, cuba_poi_aliases, display_name,
-- pick_count, is_landmark, merged_into, category_override) and 00581.
--
-- 1. lookup_nearest_poi_ranked: the label is COALESCE(display_name, name).
--    Output only — the 00570 footprint ranking stays byte-identical (in-place
--    patch of the live body; the 3-line target literal appears once).
-- 2. search_pois_smart v2: candidates come from the precomputed dictionary
--    (display / bare / alias / brand rows, trgm + prefix indexes) instead of a
--    per-row ILIKE/similarity scan of every POI in the radius; ranking =
--    match quality → landmark/admin bonus → stop-shadow demotion → rider
--    picks → staleness → confidence → distance → contact. Return shape = the
--    18 live columns in the live order + matched_alias, display_name,
--    is_landmark. Adding columns changes the return type (42P13 under
--    CREATE OR REPLACE) → DROP first; both statements run in this transaction
--    and PostgREST reloads its schema cache on DDL. `name` now carries the
--    cleaned display_name so the installed apps show clean names without a
--    rebuild; `tricigo_category` is the EFFECTIVE category (override wins).
--
-- Measured on prod before writing (2026-09-06): 40 transport stops carry the
-- exact display name of a non-transport POI ≤400 m away (the shadow rule);
-- 1,040 non-admin rows have synced_at older than 90 days while the 385 admin
-- rows all say 2026-05-03 (never re-synced) → the staleness penalty skips
-- is_admin.
-- ============================================================================
SET statement_timeout = 0;

-- 1. Reverse geocode label -------------------------------------------------
DO $patch$
DECLARE v_src text; v_n int;
  c_t CONSTANT text := E'SELECT\n    p.name,\n    p.category,';
  c_r CONSTANT text := E'SELECT\n    COALESCE(p.display_name, p.name) AS name,\n    p.category,';
BEGIN
  SELECT pg_get_functiondef('public.lookup_nearest_poi_ranked(double precision,double precision,integer)'::regprocedure) INTO v_src;
  IF position('p.display_name' IN v_src) > 0 THEN
    RAISE NOTICE '00583: lookup_nearest_poi_ranked already patched'; RETURN;
  END IF;
  v_n := (length(v_src) - length(replace(v_src, c_t, ''))) / length(c_t);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00583: lookup_nearest_poi_ranked target literal found % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_src, c_t, c_r);
  RAISE NOTICE '00583: lookup_nearest_poi_ranked now returns display_name';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00583: lookup_nearest_poi_ranked absent; skipping';
END $patch$;

-- 2. search_pois_smart v2 --------------------------------------------------
DROP FUNCTION IF EXISTS public.search_pois_smart(text, double precision, double precision, integer, integer);

CREATE FUNCTION public.search_pois_smart(
  query        text,
  lat          double precision DEFAULT 23.1136,
  lng          double precision DEFAULT -82.3666,
  radius_m     integer          DEFAULT 50000,
  max_results  integer          DEFAULT 10
)
RETURNS TABLE(
  id bigint, name text, category text, subcategory text, tricigo_category text,
  address text, municipality text, province text, latitude double precision,
  longitude double precision, phone text, website text, source text,
  is_admin boolean, confidence real, distance_m double precision,
  matched_category text, match_reason text,
  matched_alias text, display_name text, is_landmark boolean
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
-- Measured on the real rows: with JIT on, a keyword query ("hotel") spent
-- 149 ms compiling ~108 expressions for a plan that executes in 45 ms.
SET jit TO off
AS $function$
DECLARE
  v_norm             TEXT;
  v_bare             TEXT;
  v_like             TEXT;
  v_category         TEXT;
  v_query_is_keyword BOOLEAN;
  v_tokens           TEXT[];
  v_token_count      INT;
  v_longest          TEXT;
  v_transport_intent BOOLEAN;
  v_origin           geography;
BEGIN
  v_norm := regexp_replace(lower(unaccent(trim(query))), '\s+', ' ', 'g');
  IF v_norm IS NULL OR length(v_norm) < 1 THEN RETURN; END IF;
  IF lat IS NULL OR lng IS NULL THEN RETURN; END IF;   -- live behaviour: no proximity → no rows

  -- The rider wants the stop itself ("parada", "P-12", "ruta 27", "terminal"…).
  -- A leading "parada (de) …" / "guagua …" is intent, not part of the name.
  v_transport_intent := v_norm ~ '\m(parada|terminal|guagua|omnibus|estacion|ruta|p-?\d{1,2}|a\d{2}|tren|ferry|aeropuerto|taxi|lancha)\M';
  v_norm := regexp_replace(v_norm, '^(parada|guagua)(\s+de)?(\s+la|\s+el|\s+los|\s+las)?\s+', '');
  IF length(v_norm) < 1 THEN RETURN; END IF;

  v_like   := '%' || v_norm || '%';
  v_bare   := public._poi_bare_name(v_norm);
  v_origin := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;

  v_tokens := ARRAY(SELECT t FROM unnest(string_to_array(v_norm, ' ')) AS t WHERE length(t) >= 2);
  v_token_count := COALESCE(array_length(v_tokens, 1), 0);
  SELECT t INTO v_longest FROM unnest(v_tokens) AS t ORDER BY length(t) DESC, t LIMIT 1;

  SELECT k.tricigo_category INTO v_category
  FROM cuba_search_keywords k
  WHERE v_norm = k.keyword OR v_norm LIKE k.keyword || ' %'
  ORDER BY length(k.keyword) DESC
  LIMIT 1;
  SELECT EXISTS (SELECT 1 FROM cuba_search_keywords k WHERE k.keyword = v_norm) INTO v_query_is_keyword;

  RETURN QUERY
  WITH dict AS (
    -- Candidate gather: index-only on the precomputed dictionary (00579 §E).
    -- Bare-name rules: the query's generic prefix ("hotel", "paladar"…)
    -- may be absent from the row ("hotel habana libre" → "Habana Libre":
    -- rank 0.5, just below the full-name exact so "Hotel Melia Cohiba"
    -- beats the "Meliá Cohiba" twin) or DIFFERENT from the row's
    -- ("restaurante la guarida" → "Paladar La Guarida": rank 1.5, below a
    -- true prefix match so that "panadería prueba" prefers "Panadería
    -- Prueba X" over "Café de Prueba").
    SELECT d.poi_id,
           MIN(CASE
                 WHEN d.norm = v_norm                                              THEN 0
                 WHEN v_bare <> v_norm AND d.kind <> 'bare' AND d.norm = v_bare    THEN 0.5
                 WHEN d.norm LIKE v_norm || '%'                                    THEN 1
                 WHEN v_bare <> v_norm AND d.kind = 'bare' AND d.norm = v_bare     THEN 1.5
                 WHEN d.norm LIKE v_like                                           THEN 2
                 WHEN similarity(d.norm, v_norm) > 0.3                             THEN 2.8
                 ELSE 9 END)::numeric AS drank,
           bool_or(d.kind IN ('alias', 'brand')
                   AND (d.norm = v_norm OR d.norm LIKE v_norm || '%' OR d.norm LIKE v_like)) AS via_alias,
           -- The row's own name (display or bare) IS the query: with a keyword
           -- query that is the "Farmacia" / "La Farmacia" placeholder (00551).
           bool_or(d.kind IN ('display', 'bare') AND d.norm = v_norm) AS name_is_query
    FROM poi_search_names d
    WHERE d.norm LIKE v_norm || '%'
       -- pg_trgm cannot index a needle shorter than 3 chars: for "ca" the
       -- substring/similarity branches would scan the whole dictionary
       -- (measured 2.5 s on the real rows). Under 3 chars the prefix
       -- (btree text_pattern_ops) and bare-exact branches are the gather.
       OR (length(v_norm) >= 3 AND d.norm LIKE v_like)
       OR (length(v_norm) >= 3 AND d.norm % v_norm)
       OR (v_bare <> v_norm AND d.norm = v_bare)
       OR (v_token_count >= 2 AND length(v_longest) >= 3 AND d.norm LIKE '%' || v_longest || '%')
    GROUP BY d.poi_id
  ),
  cand AS (
    SELECT p.*, dict.drank, dict.via_alias, dict.name_is_query
    FROM cuba_pois p
    JOIN dict ON dict.poi_id = p.id
    WHERE p.is_active AND p.merged_into IS NULL
      AND ST_DWithin(p.location, v_origin, radius_m)
    UNION ALL
    -- Category rows not already gathered by name. Written as a LEFT JOIN
    -- anti-join: NOT EXISTS ran as a nested loop over the CTE (650k
    -- comparisons, 82 ms for "hotel") and NOT IN kept a 100k cost estimate
    -- that pushed the whole statement over jit_above_cost.
    SELECT p.*, 9::numeric AS drank, false AS via_alias, false AS name_is_query
    FROM cuba_pois p
    LEFT JOIN dict d2 ON d2.poi_id = p.id
    WHERE v_category IS NOT NULL
      AND d2.poi_id IS NULL
      AND p.is_active AND p.merged_into IS NULL
      AND COALESCE(p.category_override, p.tricigo_category) = v_category
      AND ST_DWithin(p.location, v_origin, radius_m)
  ),
  scored AS (
    -- No per-row unaccent()/regexp here: a keyword query has ~1,300
    -- candidates and each such call costs ~100 µs. Everything text-derived
    -- comes from the dictionary or the precomputed *_normalized columns;
    -- the display-name normalisation happens on the top-K window below.
    SELECT c.id, c.category, c.subcategory,
           COALESCE(c.category_override, c.tricigo_category) AS category_eff,
           COALESCE(c.display_name, c.name)                  AS disp,
           COALESCE(c.address, '')                 AS address,
           COALESCE(c.municipality, c.city, '')    AS municipality,
           COALESCE(c.province, '')                AS province,
           ST_Y(c.location::geometry) AS latitude,
           ST_X(c.location::geometry) AS longitude,
           c.location,
           c.phone, c.website, c.source, c.is_admin, c.confidence,
           COALESCE(c.is_landmark, false) AS is_landmark,
           c.pick_count, c.synced_at, c.via_alias,
           ST_Distance(c.location, v_origin) AS distance_m,
           -- Tier order: dictionary exact/bare/prefix/substring (≤2) → every
           -- query token in name/address (2.5) → trigram fuzzy (2.8) →
           -- category. The token tier is checked BEFORE fuzzy so "museo de
           -- bellas artes" prefers "Museo Nacional de Bellas Artes" (all
           -- tokens) over "Museo de Artes Decorativas" (similar trigrams).
           CASE
             WHEN c.drank <= 2 THEN c.drank
             WHEN v_token_count > 0 AND NOT EXISTS (
                    SELECT 1 FROM unnest(v_tokens) AS t
                    WHERE NOT (c.name_normalized LIKE '%' || t || '%'
                            OR COALESCE(c.address_normalized, '') LIKE '%' || t || '%'))
               THEN 2.5::numeric
             WHEN c.drank <= 2.8 THEN c.drank
             WHEN v_category IS NOT NULL AND COALESCE(c.category_override, c.tricigo_category) = v_category THEN 3::numeric
             ELSE 9::numeric
           END AS rank_quality,
           CASE WHEN v_query_is_keyword AND c.name_is_query THEN 1 ELSE 0 END AS is_generic,
           (c.category = 'public_transport'
            AND COALESCE(c.subcategory, '') IN ('platform', 'stop_position', 'stop', 'bus_stop')) AS is_stop
    FROM cand c
    WHERE c.category NOT IN ('highway', 'landuse', 'waterway', 'building', 'natural', 'barrier', 'place', 'man_made', 'railway')
      AND NOT (c.category = 'amenity' AND c.subcategory IN ('telephone', 'drinking_water'))
  ),
  filtered AS (
    SELECT s.*,
      ( s.rank_quality * 1000
        + s.is_generic * 5000
        + CASE WHEN s.is_landmark THEN -120 WHEN s.is_admin THEN -60 ELSE 0 END
        + CASE WHEN s.is_stop AND NOT v_transport_intent THEN 700 ELSE 0 END
        -- Keyword query ("farmacia", "hospital naval"): within a tier, a row of
        -- the keyword's category beats a same-named row of another category
        -- ("Farmacia Taquechel" over "Museo de la Farmacia Habanera").
        + CASE WHEN v_category IS NOT NULL AND s.category_eff <> v_category THEN 250 ELSE 0 END
        - LEAST(s.pick_count, 20) * 15
        + CASE WHEN NOT s.is_admin AND s.synced_at IS NOT NULL
                    AND s.synced_at < now() - interval '90 days' THEN 150 ELSE 0 END
        + (1 - COALESCE(s.confidence, 0.5)) * 30
        + LEAST(s.distance_m / 1000.0, 30)
        + CASE WHEN s.phone IS NOT NULL OR s.website IS NOT NULL THEN 0 ELSE 8 END
      )::numeric AS score
    FROM scored s
    WHERE s.rank_quality < 9
  ),
  top AS (
    -- The shadow rule and the 300 m collapse below need the normalised
    -- display name and a self-join; bound both to the rows that can reach
    -- the page. A duplicate or a shadow stop that outranks another row is
    -- always inside this window, so nothing the page would show is lost.
    SELECT f.*, lower(unaccent(f.disp)) AS disp_norm
    FROM filtered f
    ORDER BY f.score ASC, f.id ASC
    LIMIT GREATEST(max_results * 6, 60)
  ),
  shaded AS (
    -- A stop that carries the exact name of a real place ≤400 m away is that
    -- place's shadow ("Clínica Cira García" platform 17 m from the clinic):
    -- drop it unless the rider asked for the stop.
    SELECT t.* FROM top t
    WHERE NOT (t.is_stop AND NOT v_transport_intent AND EXISTS (
            SELECT 1 FROM cuba_pois o
            WHERE o.is_active AND o.merged_into IS NULL AND o.id <> t.id
              AND COALESCE(o.category_override, o.tricigo_category) <> 'transport'
              AND ST_DWithin(o.location, t.location, 400)
              AND lower(unaccent(COALESCE(o.display_name, o.name))) = t.disp_norm))
  ),
  collapsed AS (
    -- Same display name AND same effective category within 300 m: keep the
    -- best-scored (ties: lower id). The category guard keeps a stop named
    -- after a hotel from being folded into the hotel when the rider asked
    -- for the stop.
    SELECT f.* FROM shaded f
    WHERE NOT EXISTS (
      SELECT 1 FROM shaded b
      WHERE b.disp_norm = f.disp_norm AND b.id <> f.id
        AND b.category_eff = f.category_eff
        AND ST_DWithin(b.location, f.location, 300)
        AND (b.score < f.score OR (b.score = f.score AND b.id < f.id)))
  )
  SELECT c.id, c.disp AS name, c.category, c.subcategory, c.category_eff AS tricigo_category,
         c.address, c.municipality, c.province, c.latitude, c.longitude,
         c.phone, c.website, c.source, c.is_admin, c.confidence, c.distance_m,
         v_category AS matched_category,
         CASE c.rank_quality
           WHEN 0   THEN 'name_exact'
           WHEN 0.5 THEN 'name_bare'
           WHEN 1   THEN 'name_prefix'
           WHEN 1.5 THEN 'name_bare'
           WHEN 2   THEN 'name_substring'
           WHEN 2.5 THEN 'name_address_tokens'
           WHEN 2.8 THEN 'name_fuzzy'
           WHEN 3   THEN 'category_only'
           ELSE 'unknown' END AS match_reason,
         CASE WHEN c.via_alias THEN (
           SELECT a.alias FROM cuba_poi_aliases a
           WHERE a.poi_id = c.id
             AND (a.alias_norm = v_norm OR a.alias_norm LIKE v_norm || '%' OR a.alias_norm LIKE v_like)
           ORDER BY length(a.alias), a.id LIMIT 1) END AS matched_alias,
         c.disp AS display_name,
         c.is_landmark
  FROM collapsed c
  ORDER BY c.score ASC, c.id ASC
  LIMIT max_results;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.search_pois_smart(text, double precision, double precision, integer, integer) IS
  '00583 v2: candidates from poi_search_names (display/bare/alias/brand); rank = match tier, landmark/admin bonus, stop-shadow demotion (unless transport intent), rider picks, staleness (>90 d, non-admin), confidence, distance, contact; same-name rows within 300 m collapse; merged rows excluded. name = display_name; tricigo_category = effective (override wins).';

RESET statement_timeout;
