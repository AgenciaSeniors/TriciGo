-- ============================================================================
-- Migration 00582: find_intersection_point v5 — numeric streets by whole token,
--   exact-first ranking through the street dictionary; _street_bare_name v2
--   ("5ta Avenida" → "5ta") + dictionary recompute.
-- Found by the real-address stress run of 2026-09-06 (34 named corners and 40
-- random real intersections, A/B'd inline against prod without DDL):
--   * "Ayestarán y 19 de Mayo" resolved to "Calzada de Ayestarán y 20 de Mayo"
--     although the exact corner exists: v4 admits any name with
--     similarity > 0.3 and then orders candidates by DISTANCE only, so a fuzzy
--     neighbour closer to the seed wins over the exact one.
--   * "5ta y 42" → "Avenida 5ta B y Calle 42" ('5ta' is a substring of '5ta b').
--   * "Calle 100 y Avenida 51" → "106 y Avenida 51"; "100 e/ 25 y 27" (Marianao)
--     → "10 e/ Calle 25 y Calle 27" in Vedado, 8 km away: similarity('10','100')
--     passes the 0.3 gate. Numbers, ordinals ("5ta", "3ra a") and single
--     letters now match by whole token only — the 00554 rule for 1–2 characters,
--     extended to every grid-like name.
--   * Random control: 40 real corners queried by their own names; v4 landed
--     within 40 m on 36, v5 on 40 (the four misses were all numeric grids:
--     114/119, 119/118, 1ra Avenida/Calle 28, Calle 27/1ra Avenida).
--   * search_streets: "5ta" / "1ra" / "3ra" could not find "5ta Avenida" (Miramar)
--     or "1ra Avenida" (Varadero) because _street_bare_name strips a LEADING
--     generic word only ("Avenida 7ma" → "7ma", but "5ta Avenida" stays).
-- Name matching now goes through street_search_names (every main AND cross
-- street is in it: 12,476 = 12,476, verified) instead of regexp_replace on every
-- intersection row within the radius (33,618 rows around Vedado: 1.2–2.5 s cold).
-- Rehearsed on supabase/tests/streets/ (real rows, v4 body captured verbatim).
-- ============================================================================

-- 1. _street_bare_name v2: also drop a TRAILING "Avenida" ("5ta Avenida" → "5ta",
--    "Avenida" alone stays). Same prefix logic as 00553 otherwise.
CREATE OR REPLACE FUNCTION public._street_bare_name(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  WITH b AS (
    SELECT CASE
      WHEN s IS NULL THEN NULL
      WHEN s !~* '^(calle|avenida|avda|ave|av|calzada|carretera|autopista|paseo|callejon|callejón|pasaje|boulevard|blvd|camino|via|vía)\.?\s+\S'
        THEN s
      ELSE COALESCE(
        NULLIF(trim(regexp_replace(
          regexp_replace(
            s,
            '^(calle|avenida|avda|ave|av|calzada|carretera|autopista|paseo|callejon|callejón|pasaje|boulevard|blvd|camino|via|vía)\.?\s+',
            '', 'i'),
          '^(de las|de los|de la|del|de)\s+(?=\S)', '', 'i')), ''),
        s)
    END AS v
  )
  SELECT CASE
    WHEN v IS NULL THEN NULL
    ELSE COALESCE(NULLIF(trim(regexp_replace(v, '\s+(avenida|avda|ave|av)\.?\s*$', '', 'i')), ''), v)
  END
  FROM b;
$function$;

COMMENT ON FUNCTION public._street_bare_name(text) IS
  '00582: street name minus a leading generic word ("Calle 23" → "23", "Calzada del Cerro" → "Cerro") AND minus a trailing "Avenida" ("5ta Avenida" → "5ta"). Feeds street_search_names.norm_bare and the query side of search_streets / find_intersection_point.';

-- 2. Recompute the dictionary columns that depend on it (12,476 rows; the sync
--    trigger only inserts new names, it never rewrites existing ones).
UPDATE public.street_search_names d
   SET norm_bare          = lower(unaccent(public._street_bare_name(d.display_name))),
       norm_bare_official = lower(unaccent(public._street_bare_name(public._street_official_name(d.main_street))))
 WHERE d.norm_bare IS DISTINCT FROM lower(unaccent(public._street_bare_name(d.display_name)))
    OR d.norm_bare_official IS DISTINCT FROM lower(unaccent(public._street_bare_name(public._street_official_name(d.main_street))));

-- 3. find_intersection_point v5. Same signature and result shape as v4 (00554).
CREATE OR REPLACE FUNCTION public.find_intersection_point(p_main text, p_cross1 text, p_cross2 text DEFAULT NULL::text, p_lat double precision DEFAULT 23.1136, p_lng double precision DEFAULT '-82.3666'::numeric, p_radius_m integer DEFAULT 5000)
 RETURNS TABLE(latitude double precision, longitude double precision, address text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  -- 00582 v5. Each query term gets a match rank against the street dictionary:
  --   0 exact (bare / display / official / raw name equal), 1 whole word inside
  --   the name, 2 substring, 3 trigram similarity > 0.3. Grid-like terms — a
  --   number, an ordinal ("5ta", "3ra a"), 1–2 characters — allow ranks 0–1 only.
  -- Candidates are ordered by (main rank + cross rank) and THEN by distance, so
  -- the exact corner beats a nearer fuzzy neighbour; at least one side must be
  -- rank ≤ 1 (the v4 word gate).
  WITH p AS (
    SELECT lower(unaccent(p_main)) AS qm,
           lower(unaccent(p_cross1)) AS qc1,
           lower(unaccent(coalesce(p_cross2, ''))) AS qc2,
           p_cross2 IS NOT NULL AS has2,
           lower(unaccent(public._street_bare_name(p_main))) AS qm_core,
           lower(unaccent(public._street_bare_name(p_cross1))) AS qc1_core,
           lower(unaccent(public._street_bare_name(coalesce(p_cross2, '')))) AS qc2_core,
           ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS pt
  ), p3 AS (
    SELECT p.*,
      (qm_core  ~ '^[0-9]+[a-z]?$' OR qm_core  ~ '^[0-9]+(ra|da|ta|ma|va|na)( [a-z])?$' OR length(qm_core)  <= 2) AS qm_strict,
      (qc1_core ~ '^[0-9]+[a-z]?$' OR qc1_core ~ '^[0-9]+(ra|da|ta|ma|va|na)( [a-z])?$' OR length(qc1_core) <= 2) AS qc1_strict,
      (qc2_core ~ '^[0-9]+[a-z]?$' OR qc2_core ~ '^[0-9]+(ra|da|ta|ma|va|na)( [a-z])?$' OR length(qc2_core) <= 2) AS qc2_strict
    FROM p
  ), dict AS (
    SELECT d.main_street, d.norm_raw, d.norm_disp, d.norm_official, d.norm_bare,
           coalesce(d.norm_bare_official, '') AS bare_off,
           ' ' || regexp_replace(d.norm_raw, '[^a-z0-9]+', ' ', 'g') || ' ' AS words
    FROM public.street_search_names d
  ), rk AS (
    SELECT d.main_street,
      CASE WHEN d.norm_bare = p.qm_core OR d.bare_off = p.qm_core OR d.norm_raw = p.qm OR d.norm_disp = p.qm OR d.norm_official = p.qm THEN 0
           WHEN d.words LIKE '% ' || p.qm_core || ' %' THEN 1
           WHEN NOT p.qm_strict AND d.norm_raw LIKE '%' || p.qm || '%' THEN 2
           WHEN NOT p.qm_strict AND similarity(d.norm_raw, p.qm_core) > 0.3 THEN 3 END AS rm,
      CASE WHEN d.norm_bare = p.qc1_core OR d.bare_off = p.qc1_core OR d.norm_raw = p.qc1 OR d.norm_disp = p.qc1 OR d.norm_official = p.qc1 THEN 0
           WHEN d.words LIKE '% ' || p.qc1_core || ' %' THEN 1
           WHEN NOT p.qc1_strict AND d.norm_raw LIKE '%' || p.qc1 || '%' THEN 2
           WHEN NOT p.qc1_strict AND similarity(d.norm_raw, p.qc1_core) > 0.3 THEN 3 END AS rc1,
      CASE WHEN NOT p.has2 THEN NULL
           WHEN d.norm_bare = p.qc2_core OR d.bare_off = p.qc2_core OR d.norm_raw = p.qc2 OR d.norm_disp = p.qc2 OR d.norm_official = p.qc2 THEN 0
           WHEN d.words LIKE '% ' || p.qc2_core || ' %' THEN 1
           WHEN NOT p.qc2_strict AND d.norm_raw LIKE '%' || p.qc2 || '%' THEN 2
           WHEN NOT p.qc2_strict AND similarity(d.norm_raw, p.qc2_core) > 0.3 THEN 3 END AS rc2
    FROM dict d CROSS JOIN p3 p
  ), nearby AS MATERIALIZED (
    SELECT si.main_street, si.cross_street_1, si.cross_street_2, si.municipality, si.province,
           ST_Y(si.intersection_point::geometry) AS lat, ST_X(si.intersection_point::geometry) AS lng,
           ST_Distance(si.intersection_point, p.pt) AS dist,
           m.rm, c1.rc1 AS mc1r, c1.rc2 AS mc2r, c2.rc1 AS m2c1r, c2.rc2 AS m2c2r, p.has2
    FROM public.street_intersections si
    CROSS JOIN p3 p
    JOIN rk m  ON m.main_street  = si.main_street AND m.rm IS NOT NULL
    JOIN rk c1 ON c1.main_street = si.cross_street_1
    LEFT JOIN rk c2 ON c2.main_street = si.cross_street_2
    WHERE ST_DWithin(si.intersection_point, p.pt, p_radius_m)
      AND (c1.rc1 IS NOT NULL OR c1.rc2 IS NOT NULL)
  ), exact_corner AS (
    -- "X e/ Y y Z" where one intersection row already carries both cross streets.
    SELECT n.lat, n.lng,
      public._street_full_display(n.main_street) || ' e/ ' || public._street_full_display(n.cross_street_1)
        || ' y ' || public._street_full_display(n.cross_street_2)
        || coalesce(', ' || n.municipality, '') || coalesce(', ' || n.province, '') AS addr
    FROM nearby n
    WHERE n.has2 AND n.cross_street_2 IS NOT NULL
      AND ((n.mc1r IS NOT NULL AND n.m2c2r IS NOT NULL) OR (n.mc2r IS NOT NULL AND n.m2c1r IS NOT NULL))
    ORDER BY n.rm + LEAST(coalesce(n.mc1r, 9) + coalesce(n.m2c2r, 9), coalesce(n.mc2r, 9) + coalesce(n.m2c1r, 9)), n.dist
    LIMIT 1
  ), c AS (
    SELECT n.*, LEAST(coalesce(n.mc1r, 9), coalesce(n.mc2r, 9)) AS rc
    FROM nearby n
    WHERE n.rm <= 1 OR LEAST(coalesce(n.mc1r, 9), coalesce(n.mc2r, 9)) <= 1
  ), best AS (
    SELECT c.main_street FROM c ORDER BY c.rm + c.rc, c.dist LIMIT 1
  ), picked AS (
    SELECT b.main_street AS c_main,
      (SELECT c.lat FROM c WHERE c.main_street = b.main_street AND c.mc1r IS NOT NULL ORDER BY c.mc1r, c.dist LIMIT 1) AS lat1,
      (SELECT c.lng FROM c WHERE c.main_street = b.main_street AND c.mc1r IS NOT NULL ORDER BY c.mc1r, c.dist LIMIT 1) AS lng1,
      (SELECT c.cross_street_1 FROM c WHERE c.main_street = b.main_street AND c.mc1r IS NOT NULL ORDER BY c.mc1r, c.dist LIMIT 1) AS x1,
      (SELECT c.lat FROM c WHERE c.main_street = b.main_street AND c.mc2r IS NOT NULL ORDER BY c.mc2r, c.dist LIMIT 1) AS lat2,
      (SELECT c.lng FROM c WHERE c.main_street = b.main_street AND c.mc2r IS NOT NULL ORDER BY c.mc2r, c.dist LIMIT 1) AS lng2,
      (SELECT c.cross_street_1 FROM c WHERE c.main_street = b.main_street AND c.mc2r IS NOT NULL ORDER BY c.mc2r, c.dist LIMIT 1) AS x2,
      (SELECT c.lat FROM c WHERE c.main_street = b.main_street ORDER BY c.rc, c.dist LIMIT 1) AS lat0,
      (SELECT c.lng FROM c WHERE c.main_street = b.main_street ORDER BY c.rc, c.dist LIMIT 1) AS lng0,
      (SELECT c.municipality FROM c WHERE c.main_street = b.main_street AND c.municipality IS NOT NULL ORDER BY c.rc, c.dist LIMIT 1) AS muni,
      (SELECT c.province FROM c WHERE c.main_street = b.main_street AND c.province IS NOT NULL ORDER BY c.rc, c.dist LIMIT 1) AS prov
    FROM best b
  )
  SELECT ec.lat, ec.lng, ec.addr FROM exact_corner ec
  UNION ALL
  SELECT
    CASE WHEN pk.lat1 IS NOT NULL AND pk.lat2 IS NOT NULL THEN (pk.lat1 + pk.lat2) / 2.0
         WHEN pk.lat1 IS NOT NULL THEN pk.lat1 ELSE pk.lat0 END,
    CASE WHEN pk.lng1 IS NOT NULL AND pk.lng2 IS NOT NULL THEN (pk.lng1 + pk.lng2) / 2.0
         WHEN pk.lng1 IS NOT NULL THEN pk.lng1 ELSE pk.lng0 END,
    public._street_full_display(pk.c_main)
      || CASE WHEN p.has2
              THEN ' e/ ' || public._street_full_display(coalesce(pk.x1, initcap(p_cross1)))
                   || ' y ' || public._street_full_display(coalesce(pk.x2, initcap(p_cross2)))
              ELSE ' y ' || public._street_full_display(coalesce(pk.x1, initcap(p_cross1))) END
      || coalesce(', ' || pk.muni, '') || coalesce(', ' || pk.prov, '')
  FROM picked pk CROSS JOIN p3 p
  WHERE NOT EXISTS (SELECT 1 FROM exact_corner)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.find_intersection_point(text, text, text, double precision, double precision, integer) IS
  '00582 v5: "X y Y" / "X e/ Y y Z" → coordinates + canonical address. Dictionary-ranked (exact > word > substring > trgm), grid-like names by whole token only, then distance. v4 (00554) picked by distance alone and confused 19 de Mayo/20 de Mayo, 5ta/5ta B, 100/10.';
