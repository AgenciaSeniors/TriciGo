-- supabase/tests/streets/scaffold.sql — the street-search objects 00582 touches,
-- captured VERBATIM from prod (pg_get_functiondef, 2026-09-06) so the migration is
-- rehearsed against what actually runs. Fixtures: 83 real intersections
-- (fixtures.psv) covering the corners the 2026-09-06 stress run got wrong.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE OR REPLACE FUNCTION public._street_display_name(s text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN
      trim(regexp_replace(s, '^.+\s+\(([^)]+)\)\s*$', '\1'))
    ELSE s
  END;
$function$;

CREATE OR REPLACE FUNCTION public._street_official_name(s text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN trim(regexp_replace(s, '^(.+)\s+\([^)]+\)\s*$', '\1'))
    ELSE s
  END;
$function$;

CREATE OR REPLACE FUNCTION public._street_full_display(s text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN s IS NULL OR s = '' THEN ''
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN
      trim(regexp_replace(s, '^.+\s+\(([^)]+)\)\s*$', '\1'))
        || ' ('
        || trim(regexp_replace(s, '^(.+)\s+\([^)]+\)\s*$', '\1'))
        || ')'
    ELSE s
  END;
$function$;

-- _street_bare_name as it runs in prod before 00582 (00553): leading generic word only.
CREATE OR REPLACE FUNCTION public._street_bare_name(s text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
  END;
$function$;

CREATE TABLE public.street_intersections (
  id bigserial PRIMARY KEY,
  main_street text,
  cross_street_1 text,
  cross_street_2 text,
  intersection_point geography(Point,4326),
  municipality text,
  province text,
  bearing smallint,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_street_intersections_geo ON public.street_intersections USING gist (intersection_point);
CREATE INDEX idx_street_intersections_main ON public.street_intersections USING btree (main_street);
CREATE INDEX idx_street_intersections_main_trgm ON public.street_intersections USING gin (main_street gin_trgm_ops);

CREATE TABLE public.street_search_names (
  main_street text PRIMARY KEY,
  display_name text,
  norm_raw text,
  norm_disp text,
  norm_official text,
  norm_bare text,
  norm_bare_official text
);

CREATE OR REPLACE FUNCTION public._street_search_names_sync()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.street_search_names
    (main_street, display_name, norm_raw, norm_disp, norm_official, norm_bare, norm_bare_official)
  SELECT DISTINCT
    n.main_street,
    public._street_display_name(n.main_street),
    lower(unaccent(n.main_street)),
    lower(unaccent(public._street_display_name(n.main_street))),
    lower(unaccent(public._street_official_name(n.main_street))),
    lower(unaccent(public._street_bare_name(public._street_display_name(n.main_street)))),
    lower(unaccent(public._street_bare_name(public._street_official_name(n.main_street))))
  FROM new_rows n
  WHERE n.main_street IS NOT NULL
  ON CONFLICT (main_street) DO NOTHING;

  RETURN NULL;
END;
$function$;
CREATE TRIGGER trg_street_search_names_ins AFTER INSERT ON public.street_intersections
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._street_search_names_sync();
CREATE TRIGGER trg_street_search_names_upd AFTER UPDATE ON public.street_intersections
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public._street_search_names_sync();

-- find_intersection_point v4 (00554) — the live body 00582 replaces.
CREATE OR REPLACE FUNCTION public.find_intersection_point(p_main text, p_cross1 text, p_cross2 text DEFAULT NULL::text, p_lat double precision DEFAULT 23.1136, p_lng double precision DEFAULT '-82.3666'::numeric, p_radius_m integer DEFAULT 5000)
 RETURNS TABLE(latitude double precision, longitude double precision, address text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  WITH params AS (
    SELECT
      lower(unaccent(p_main)) AS qm, lower(unaccent(p_cross1)) AS qc1,
      lower(unaccent(COALESCE(p_cross2,''))) AS qc2,
      trim(regexp_replace(lower(unaccent(p_main)),   '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+','')) AS qm_core,
      trim(regexp_replace(lower(unaccent(p_cross1)), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+','')) AS qc1_core,
      trim(regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+','')) AS qc2_core,
      ' '||regexp_replace(lower(unaccent(p_main)),   '[^a-z0-9]+',' ','g')||' ' AS qm_words,
      ' '||regexp_replace(lower(unaccent(p_cross1)), '[^a-z0-9]+',' ','g')||' ' AS qc1_words,
      ' '||regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '[^a-z0-9]+',' ','g')||' ' AS qc2_words
  ),
  p2 AS (
    SELECT p.*,
      length(p.qm_core)  BETWEEN 1 AND 2 AS qm_short,
      length(p.qc1_core) BETWEEN 1 AND 2 AS qc1_short,
      length(p.qc2_core) BETWEEN 1 AND 2 AS qc2_short
    FROM params p
  ),
  nearby AS MATERIALIZED (
    SELECT ST_Y(si.intersection_point::geometry) AS lat, ST_X(si.intersection_point::geometry) AS lng,
      si.main_street, si.cross_street_1, si.cross_street_2, si.municipality, si.province,
      ST_Distance(si.intersection_point, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography) AS dist,
      lower(unaccent(si.main_street)) AS nm, lower(unaccent(si.cross_street_1)) AS nc1,
      lower(unaccent(COALESCE(si.cross_street_2,''))) AS nc2
    FROM street_intersections si, p2 p
    WHERE ST_DWithin(si.intersection_point, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography, p_radius_m)
      AND (CASE WHEN p.qm_short
             THEN ' '||regexp_replace(lower(unaccent(si.main_street)),'[^a-z0-9]+',' ','g')||' ' LIKE '% '||p.qm_core||' %'
             ELSE (lower(unaccent(si.main_street)) LIKE '%'||p.qm||'%'
                   OR similarity(lower(unaccent(si.main_street)), p.qm_core) > 0.3)
           END)
  ),
  scored AS MATERIALIZED (
    SELECT n.*,
      (CASE WHEN p.qc1_short THEN ' '||regexp_replace(n.nc1,'[^a-z0-9]+',' ','g')||' ' LIKE '% '||p.qc1_core||' %'
            ELSE (n.nc1 LIKE '%'||p.qc1||'%' OR similarity(n.nc1, p.qc1_core) > 0.3) END) AS mc1,
      (p_cross2 IS NOT NULL AND
       CASE WHEN p.qc2_short THEN ' '||regexp_replace(n.nc1,'[^a-z0-9]+',' ','g')||' ' LIKE '% '||p.qc2_core||' %'
            ELSE (n.nc1 LIKE '%'||p.qc2||'%' OR similarity(n.nc1, p.qc2_core) > 0.3) END) AS mc2,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL AND
       CASE WHEN p.qc1_short THEN ' '||regexp_replace(n.nc2,'[^a-z0-9]+',' ','g')||' ' LIKE '% '||p.qc1_core||' %'
            ELSE (n.nc2 LIKE '%'||p.qc1||'%' OR similarity(n.nc2, p.qc1_core) > 0.3) END) AS m2c1,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL AND
       CASE WHEN p.qc2_short THEN ' '||regexp_replace(n.nc2,'[^a-z0-9]+',' ','g')||' ' LIKE '% '||p.qc2_core||' %'
            ELSE (n.nc2 LIKE '%'||p.qc2||'%' OR similarity(n.nc2, p.qc2_core) > 0.3) END) AS m2c2,
      (' '||regexp_replace(n.nm,'[^a-z0-9]+',' ','g')||' ' LIKE '%'||p.qm_words||'%'
        OR ' '||regexp_replace(n.nc1,'[^a-z0-9]+',' ','g')||' ' LIKE '%'||p.qc1_words||'%'
        OR (p_cross2 IS NOT NULL AND ' '||regexp_replace(n.nc1,'[^a-z0-9]+',' ','g')||' ' LIKE '%'||p.qc2_words||'%')) AS word_gate
    FROM nearby n CROSS JOIN p2 p
  ),
  exact_corner AS (
    SELECT s.lat, s.lng,
      public._street_full_display(s.main_street)||' e/ '||public._street_full_display(s.cross_street_1)
        ||' y '||public._street_full_display(s.cross_street_2)
        ||COALESCE(', '||s.municipality,'')||COALESCE(', '||s.province,'') AS addr
    FROM scored s WHERE (s.mc1 AND s.m2c2) OR (s.mc2 AND s.m2c1) ORDER BY s.dist LIMIT 1
  ),
  candidates AS (SELECT * FROM scored s WHERE (s.mc1 OR s.mc2) AND s.word_gate),
  picked AS (
    SELECT (SELECT c.main_street FROM candidates c ORDER BY c.dist LIMIT 1) AS c_main,
      (SELECT c.lat FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS lat1,
      (SELECT c.lng FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS lng1,
      (SELECT c.cross_street_1 FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS x1,
      (SELECT c.lat FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS lat2,
      (SELECT c.lng FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS lng2,
      (SELECT c.cross_street_1 FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS x2,
      (SELECT c.lat FROM candidates c ORDER BY c.dist LIMIT 1) AS lat0,
      (SELECT c.lng FROM candidates c ORDER BY c.dist LIMIT 1) AS lng0,
      (SELECT c.municipality FROM candidates c WHERE c.municipality IS NOT NULL ORDER BY c.dist LIMIT 1) AS muni,
      (SELECT c.province FROM candidates c WHERE c.province IS NOT NULL ORDER BY c.dist LIMIT 1) AS prov,
      EXISTS (SELECT 1 FROM candidates) AS has_any
  )
  SELECT ec.lat, ec.lng, ec.addr FROM exact_corner ec
  UNION ALL
  SELECT
    CASE WHEN p.lat1 IS NOT NULL AND p.lat2 IS NOT NULL THEN (p.lat1+p.lat2)/2.0
         WHEN p.lat1 IS NOT NULL THEN p.lat1 ELSE p.lat0 END,
    CASE WHEN p.lng1 IS NOT NULL AND p.lng2 IS NOT NULL THEN (p.lng1+p.lng2)/2.0
         WHEN p.lng1 IS NOT NULL THEN p.lng1 ELSE p.lng0 END,
    public._street_full_display(p.c_main)
      || CASE WHEN p_cross2 IS NOT NULL
              THEN ' e/ '||public._street_full_display(COALESCE(p.x1, initcap(p_cross1)))
                        ||' y '||public._street_full_display(COALESCE(p.x2, initcap(p_cross2)))
              ELSE ' y '||public._street_full_display(COALESCE(p.x1, initcap(p_cross1))) END
      || COALESCE(', '||p.muni,'') || COALESCE(', '||p.prov,'')
  FROM picked p WHERE p.has_any AND NOT EXISTS (SELECT 1 FROM exact_corner)
  LIMIT 1;
$function$;

-- Fixtures (real prod rows; the dictionary trigger fills street_search_names).
CREATE TEMP TABLE stage (main text, c1 text, c2 text, muni text, prov text, lat float8, lng float8);
\copy stage FROM 'supabase/tests/streets/fixtures.psv' WITH (FORMAT csv, DELIMITER '|', NULL '')
INSERT INTO public.street_intersections (main_street, cross_street_1, cross_street_2, municipality, province, intersection_point)
SELECT main, c1, c2, muni, prov, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography FROM stage;
