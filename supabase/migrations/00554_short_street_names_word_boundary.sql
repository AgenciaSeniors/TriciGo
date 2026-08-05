-- ============================================================
-- Migration 00554: buscar la calle "L" traía la calle K — un nombre de una
--                  letra convertía el filtro en un comodín
--
-- WHY (medido contra prod):
--
--   Las dos RPC que resuelven una dirección cubana escrita ("X e/ Y y Z")
--   filtran las calles por SUBSTRING:
--
--     lower(unaccent(si.main_street)) LIKE '%' || p.qm || '%'
--
--   Con un nombre de UNA letra eso deja de filtrar. La palabra "calle"
--   contiene una `l`, una `a`, una `c` y una `e`, así que buscar la calle
--   "L" matchea TODA calle llamada "Calle …":
--
--     tecleado   calles que pasan el filtro   calles que se llaman así
--     a                    10.669                        1
--     e                     9.597                        1
--     n                     7.001                        2
--     l                     6.883                        1
--     c                     6.421                        2
--     9                       461                        1
--
--   De 12.476 nombres, 10.669 pasan el filtro de "A". Lo que decide entonces
--   es la cercanía, así que gana cualquier calle de la cuadra. Medido desde
--   el Vedado (23.1370, -82.3830):
--
--     tecleado          devolvía                          debía devolver
--     L e/ 23 y 25      Calle K e/ 23 y 25                Calle L e/ 23 y 25
--     C e/ 17 y 19      Calle K e/ 17 y 19                Calle C e/ 17 y 19
--     A e/ 5ta y 3ra    Calle H e/ 5ta y 3ra              Calle A e/ 5ta y 3ra
--     23 e/ L y M       Infanta a 23 e/ La Rampa y 23     Calle 23 e/ L y M
--     N e/ 9 y 11       Calle N e/ **19** y 11            Calle N e/ 9 y 11
--
--   El último es literal el caso que abrió esta campaña: `'%9%'` matchea
--   "19", así que la transversal cambia sola de calle. (El otro extremo del
--   mismo síntoma —la ETIQUETA de un pin— se arregló en 00547.)
--
--   Esto importa más que un ranking de búsqueda: find_intersection_point
--   produce el PIN de recogida. Y las calles de una letra no son un caso
--   raro — son la malla del Vedado, Miramar y decenas de repartos: 43
--   nombres sobre 41.969 esquinas, el 11 % de las intersecciones del país.
--
--   El word_gate que agregó 00549 no salva esto: es un OR entre principal y
--   transversales, así que una fila con la transversal correcta entra aunque
--   su calle principal sea otra. Por eso "Calle K e/ 23 y 25" pasaba.
--
-- WHAT THIS DOES:
--   Cuando el nombre buscado tiene 1 o 2 caracteres (ya sin su prefijo
--   genérico), se exige PALABRA COMPLETA en vez de substring, y se suelta el
--   trigrama — a esa longitud `similarity()` es ruido. Para todo lo demás el
--   filtro es idéntico al de hoy, byte a byte.
--
--   Se aplica a las dos funciones y a las tres posiciones (principal,
--   transversal 1, transversal 2), porque el defecto es el mismo en todas.
--
-- MEDIDO — find_intersection_point, ida y vuelta contra prod
-- (un punto real → get_nearest_cross_streets da "X e/ Y y Z" → se le devuelve
--  a la función y se mide a qué distancia del punto original cae):
--
--   | suite                                    |  n  | viva  |  v4  |
--   |------------------------------------------|-----|-------|------|
--   | esquinas con calle corta, forma guardada  | 103 |  96   |  98  |  (≤50 m)
--   |   …de esas, más de 200 m                  |     |   2   |   0  |
--   |   …peor error                             |     |1.876 m|  72 m|
--   | esquinas con calle corta, forma PELADA    |  89 |  69   |  73  |  (≤50 m)
--   |   …de esas, más de 200 m                  |     |   5   |   0  |
--   |   …peor error                             |     |3.294 m|  64 m|
--   | control: calles largas                    |  94 |  86   |  86  |
--   |   …empeora                                |     |   —   |   0  |
--
--   La forma "pelada" es la que teclea la gente ("N e/ 9 y 11", no "Calle N
--   e/ Calle 9 y Calle 11"). Ningún caso pierde su resultado; el peor error
--   pasa de 3,3 km a 64 m. Una regresión de menos de 200 m en 89 casos.
--
-- MEDIDO — suggest_cross_streets (el autocompletado de la transversal):
--   Tecleando "L" desde el Vedado proponía transversales de calles ajenas
--   —"27 de Noviembre (Jovellar)", "Avenida Obispo Espada", "Calle 1",
--   "Calle 10"— en vez de las de Calle L. Ahora: "Calle 27, 27 de Noviembre,
--   Calle 25, Calle 23, Calle 21".
--
-- RENDIMIENTO: MEJORA, no empata. El filtro estricto recorta el candidato de
--   10.669 nombres a un puñado (caliente, alternado, 3 corridas):
--     A e/ 5ta y 3ra   325 → 99 ms
--     L e/ 23 y 25     245 → 95 ms
--     N e/ 9 y 11      224 → 95 ms
--   Controles sin cambio: Belascoaín 127 → 125 ms, Infanta 123 → 123 ms.
--
-- CAMBIO DE ORDEN en suggest_cross_streets: se agrega `min(distancia)` como
--   desempate antes del alfabético. La app muestra ~6 sugerencias; con orden
--   alfabético alguien parado en 23 veía "Calle 11, 13, 15…". Ahora ve las
--   esquinas que tiene al lado. El criterio principal (similarity DESC) no
--   se toca.
--
-- WHAT STAYS: firmas, columnas devueltas, radios por defecto, SECURITY
--   DEFINER, exact_corner (00549), word_gate (00549), el despojo del prefijo
--   del lado de la consulta y el `SET search_path` de siempre. Los cuerpos se
--   transcriben desde `pg_get_functiondef` VIVO, no desde la migración de git
--   (00363 no es lo que corre hoy) — ver la lección de 00519 en CLAUDE.md.
-- ============================================================

-- ── 1. find_intersection_point v4 ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_intersection_point(
  p_main text,
  p_cross1 text,
  p_cross2 text DEFAULT NULL::text,
  p_lat double precision DEFAULT 23.1136,
  p_lng double precision DEFAULT '-82.3666'::numeric,
  p_radius_m integer DEFAULT 5000
)
RETURNS TABLE(latitude double precision, longitude double precision, address text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  WITH params AS (
    SELECT
      lower(unaccent(p_main))   AS qm,
      lower(unaccent(p_cross1)) AS qc1,
      lower(unaccent(COALESCE(p_cross2,''))) AS qc2,
      trim(regexp_replace(lower(unaccent(p_main)),   '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qm_core,
      trim(regexp_replace(lower(unaccent(p_cross1)), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qc1_core,
      trim(regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qc2_core,
      ' '||regexp_replace(lower(unaccent(p_main)),   '[^a-z0-9]+', ' ', 'g')||' ' AS qm_words,
      ' '||regexp_replace(lower(unaccent(p_cross1)), '[^a-z0-9]+', ' ', 'g')||' ' AS qc1_words,
      ' '||regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '[^a-z0-9]+', ' ', 'g')||' ' AS qc2_words
  ),
  -- 00554: un nombre de 1-2 caracteres no se puede buscar por substring.
  p2 AS (
    SELECT p.*,
      length(p.qm_core)  BETWEEN 1 AND 2 AS qm_short,
      length(p.qc1_core) BETWEEN 1 AND 2 AS qc1_short,
      length(p.qc2_core) BETWEEN 1 AND 2 AS qc2_short
    FROM params p
  ),
  nearby AS MATERIALIZED (
    SELECT
      ST_Y(si.intersection_point::geometry) AS lat,
      ST_X(si.intersection_point::geometry) AS lng,
      si.main_street, si.cross_street_1, si.cross_street_2,
      si.municipality, si.province,
      ST_Distance(si.intersection_point, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography) AS dist,
      lower(unaccent(si.main_street))    AS nm,
      lower(unaccent(si.cross_street_1)) AS nc1,
      lower(unaccent(COALESCE(si.cross_street_2,''))) AS nc2
    FROM street_intersections si, p2 p
    WHERE ST_DWithin(si.intersection_point, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography, p_radius_m)
      AND (CASE WHEN p.qm_short
             -- Palabra completa. Con substring, '%l%' matchea toda calle
             -- llamada "Calle …" (la palabra "calle" tiene una l) = 6.883 de
             -- 12.476 nombres, y decide la cercanía: por eso "L e/ 23 y 25"
             -- devolvía Calle K. El trigrama se suelta porque con 1-2
             -- caracteres similarity() es ruido.
             THEN ' '||regexp_replace(lower(unaccent(si.main_street)), '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||p.qm_core||' %'
             ELSE (lower(unaccent(si.main_street)) LIKE '%'||p.qm||'%'
                   OR similarity(lower(unaccent(si.main_street)), p.qm_core) > 0.3)
           END)
  ),
  scored AS MATERIALIZED (
    SELECT n.*,
      (CASE WHEN p.qc1_short
            THEN ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||p.qc1_core||' %'
            ELSE (n.nc1 LIKE '%'||p.qc1||'%' OR similarity(n.nc1, p.qc1_core) > 0.3) END) AS mc1,
      (p_cross2 IS NOT NULL AND
       CASE WHEN p.qc2_short
            THEN ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||p.qc2_core||' %'
            ELSE (n.nc1 LIKE '%'||p.qc2||'%' OR similarity(n.nc1, p.qc2_core) > 0.3) END) AS mc2,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL AND
       CASE WHEN p.qc1_short
            THEN ' '||regexp_replace(n.nc2, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||p.qc1_core||' %'
            ELSE (n.nc2 LIKE '%'||p.qc1||'%' OR similarity(n.nc2, p.qc1_core) > 0.3) END) AS m2c1,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL AND
       CASE WHEN p.qc2_short
            THEN ' '||regexp_replace(n.nc2, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||p.qc2_core||' %'
            ELSE (n.nc2 LIKE '%'||p.qc2||'%' OR similarity(n.nc2, p.qc2_core) > 0.3) END) AS m2c2,
      (' '||regexp_replace(n.nm,  '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qm_words||'%'
        OR ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qc1_words||'%'
        OR (p_cross2 IS NOT NULL
            AND ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qc2_words||'%')) AS word_gate
    FROM nearby n CROSS JOIN p2 p
  ),
  exact_corner AS (
    SELECT s.lat, s.lng,
      public._street_full_display(s.main_street)
        || ' e/ ' || public._street_full_display(s.cross_street_1)
        || ' y '  || public._street_full_display(s.cross_street_2)
        || COALESCE(', ' || s.municipality, '') || COALESCE(', ' || s.province, '') AS addr
    FROM scored s
    WHERE (s.mc1 AND s.m2c2) OR (s.mc2 AND s.m2c1)
    ORDER BY s.dist LIMIT 1
  ),
  candidates AS (
    SELECT * FROM scored s WHERE (s.mc1 OR s.mc2) AND s.word_gate
  ),
  picked AS (
    SELECT
      (SELECT c.main_street    FROM candidates c ORDER BY c.dist LIMIT 1)             AS c_main,
      (SELECT c.lat            FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS lat1,
      (SELECT c.lng            FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS lng1,
      (SELECT c.cross_street_1 FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1) AS x1,
      (SELECT c.lat            FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS lat2,
      (SELECT c.lng            FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS lng2,
      (SELECT c.cross_street_1 FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1) AS x2,
      (SELECT c.lat FROM candidates c ORDER BY c.dist LIMIT 1) AS lat0,
      (SELECT c.lng FROM candidates c ORDER BY c.dist LIMIT 1) AS lng0,
      (SELECT c.municipality FROM candidates c WHERE c.municipality IS NOT NULL ORDER BY c.dist LIMIT 1) AS muni,
      (SELECT c.province     FROM candidates c WHERE c.province     IS NOT NULL ORDER BY c.dist LIMIT 1) AS prov,
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
  FROM picked p
  WHERE p.has_any AND NOT EXISTS (SELECT 1 FROM exact_corner)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.find_intersection_point(text, text, text, double precision, double precision, integer) IS
  '00554: resuelve "X e/ Y y Z" a un punto. Los nombres de 1-2 caracteres se matchean por palabra '
  'completa, no por substring — con substring, buscar la calle "L" matcheaba las 6.883 calles '
  'llamadas "Calle …" y devolvía la más cercana (Calle K). Peor error medido: 3.294 m → 64 m.';

-- ── 2. suggest_cross_streets v2 ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_cross_streets(
  p_main text,
  p_lat double precision DEFAULT 23.1136,
  p_lng double precision DEFAULT '-82.3666'::numeric,
  p_radius_m integer DEFAULT 3000
)
RETURNS TABLE(cross_street text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_escaped TEXT;
  v_norm    TEXT;
  v_core    TEXT;
  v_short   BOOLEAN;
  v_pt      geography;
BEGIN
  v_escaped := replace(replace(replace(p_main, '\', '\\'), '%', '\%'), '_', '\_');
  v_norm    := unaccent(lower(trim(p_main)));
  v_core    := trim(regexp_replace(v_norm, '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', ''));
  v_short   := length(v_core) BETWEEN 1 AND 2;
  v_pt      := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  RETURN QUERY
  SELECT si.cross_street_1
  FROM street_intersections si
  WHERE ST_DWithin(si.intersection_point, v_pt, p_radius_m)
    AND si.cross_street_1 IS NOT NULL
    AND (CASE WHEN v_short
           -- Mismo defecto que en find_intersection_point: tecleando "L" el
           -- substring matchea toda calle llamada "Calle …" y las sugerencias
           -- salían de calles ajenas ("27 de Noviembre", "Obispo Espada").
           THEN ' '||regexp_replace(unaccent(lower(si.main_street)), '[^a-z0-9]+', ' ', 'g')||' ' LIKE '% '||v_core||' %'
           ELSE (unaccent(si.main_street) ILIKE unaccent('%' || v_escaped || '%')
                 OR similarity(unaccent(si.main_street), v_norm) > 0.3)
         END)
  GROUP BY si.cross_street_1
  ORDER BY
    max(similarity(unaccent(si.main_street), v_norm)) DESC,
    -- 00554: la esquina más cercana primero. Solo se ven ~6 sugerencias, y el
    -- desempate alfabético le mostraba "Calle 11, 13, 15…" a quien está en 23.
    min(ST_Distance(si.intersection_point, v_pt)),
    si.cross_street_1
  LIMIT 10;
END;
$function$;

COMMENT ON FUNCTION public.suggest_cross_streets(text, double precision, double precision, integer) IS
  '00554: transversales sugeridas para una calle. Los nombres de 1-2 caracteres se matchean por '
  'palabra completa (tecleando "L" proponía transversales de cualquier calle con una l), y a igual '
  'similitud gana la esquina más cercana en vez del orden alfabético.';

-- Andamios de prueba creados a mano en prod para comparar contra las vivas.
DROP FUNCTION IF EXISTS public.find_intersection_point_v4c(text, text, text, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.suggest_cross_streets_v2c(text, double precision, double precision, integer);
DROP TABLE    IF EXISTS public.zzz_bare_cross;
