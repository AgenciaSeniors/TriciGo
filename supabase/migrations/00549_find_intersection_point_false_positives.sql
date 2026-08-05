-- ============================================================
-- Migration 00549: find_intersection_point v3 — el cruce tecleado resuelve
--                  exacto, y una esquina inexistente ya no inventa un pin
--
-- WHY (todo medido contra prod con la función real; suites de 100/80/100/60
-- casos, reproducibles con las queries del PR #932):
--
--   `find_intersection_point` resuelve el patrón cubano "X e/ Y y Z" a
--   coordenadas. Lo llama el cliente cuando el pasajero teclea una dirección
--   completa. La versión viva tenía TRES defectos medidos:
--
--   1. UNA ESQUINA REAL RESOLVÍA LEJOS. 100 esquinas reales tecleadas con sus
--      tres nombres exactos desde su propia ubicación: solo 85 caían a ≤50 m;
--      peor caso 1.787 m. Causa: la función nunca miraba `cross_street_2` —
--      reconstruía el cruce como punto medio de DOS filas buscadas por
--      `cross_street_1`, y si faltaba la fila de orientación esperada, el
--      punto medio se iba a otra cuadra (o a otra calle homónima del radio).
--
--   2. UNA ESQUINA INEXISTENTE INVENTABA UN PIN. 60 pares imposibles (calle
--      de La Habana + transversal de Santiago): 10 devolvían un punto — hasta
--      4.848 m — sin ninguna señal de error. Causa: el umbral de trigrama 0.3
--      se aplicaba a los dos nombres a la vez y dos coincidencias flojas se
--      componían en un candidato "confiado".
--
--   3. `similarity('Calle Arango','Calle 23') > 0.3`: la palabra genérica
--      "Calle" infla el trigrama entre calles que no se parecen EN NADA. Es
--      el mecanismo exacto del bug histórico "Calle 9/Calle 11 → Calle
--      Fomento y Calle Arango" que motivó quitar el snap de coordenadas del
--      cliente (PR #929).
--
-- WHAT THIS DOES (tres piezas, cada una cierra un defecto):
--
--   A. RAMA exact_corner: si una fila codifica el cruce completo tecleado
--      (main + ambas transversales, en cualquier orden), se devuelve SU punto
--      y SU dirección canónica — cero reconstrucción por punto medio.
--
--   B. GATE de palabra completa: al menos UNO de los nombres tecleados debe
--      aparecer como PALABRA entera (texto normalizado sin tildes ni
--      puntuación) en la fila candidata. Dos trigramas flojos ya no bastan.
--
--   C. La similitud se calcula contra la consulta SIN su prefijo genérico
--      (calle/avenida/calzada/…), despojado UNA vez del lado de la consulta.
--      Así 'calle arango' ~ '23' no pasa el 0.3, pero 'arango' con errata
--      sigue matcheando 'Calle Arango'. Solo del lado de la consulta:
--      despojar también el lado de la fila costaba un regex por fila (medido:
--      2.176 → 851 ms por llamada) y no aporta — la inflación necesitaba
--      "calle" en AMBOS lados.
--
-- MEDIDO, viva vs v3 (mismas suites):
--
--   | suite                                    | viva      | v3        |
--   |------------------------------------------|-----------|-----------|
--   | 100 esquinas reales "X e/ Y y Z" ≤50 m   | 85 (1787) | 100 (0 m) |
--   | 80 con ERRATA en la principal ≤50 m      | 70        | 80 (0 m)  |
--   | 100 con una transversal "X y Y" ≤50 m    | —         | 100 (0 m) |
--   | 60 inexistentes → inventa un pin         | 10        | 1         |
--
--   El residual (1/60): "48A e/ C" → "48 y 7ma C" a 1 km. "C" es una palabra
--   real (el Vedado tiene calles de una letra) — irreducible sin romper las
--   calles de una letra. Ese caso pasa igualmente por confirmación de pin en
--   el cliente (00537 confirmPin).
--
--   Latencia: paridad con la viva (corridas alternadas en caliente: viva
--   264-464 ms, v3 172-440 ms — el ruido del servidor domina; el timeout del
--   cliente es 2000 ms). La estructura de un solo escaneo del radio con el
--   filtro de la principal DENTRO del escaneo es lo que la mantiene ahí:
--   materializar el radio entero antes de filtrar costaba 851-1.253 ms.
--
-- WHAT STAYS: firma, columnas, radio 5000 por defecto, SECURITY DEFINER y su
--   search_path, el fallback initcap() cuando un nombre no se encontró, y el
--   punto medio como último recurso (cruces tecleados con nombres que solo
--   existen en filas de orientaciones distintas).
-- ============================================================

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
      -- Núcleo sin prefijo genérico, SOLO del lado de la consulta (pieza C).
      trim(regexp_replace(lower(unaccent(p_main)),   '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qm_core,
      trim(regexp_replace(lower(unaccent(p_cross1)), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qc1_core,
      trim(regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '^(calle|avenida|ave|avda|calzada|carretera|callejon|paseo|camino|pasaje)\s+', '')) AS qc2_core,
      -- Formas con delimitadores para el gate de palabra completa (pieza B).
      ' '||regexp_replace(lower(unaccent(p_main)),   '[^a-z0-9]+', ' ', 'g')||' ' AS qm_words,
      ' '||regexp_replace(lower(unaccent(p_cross1)), '[^a-z0-9]+', ' ', 'g')||' ' AS qc1_words,
      ' '||regexp_replace(lower(unaccent(COALESCE(p_cross2,''))), '[^a-z0-9]+', ' ', 'g')||' ' AS qc2_words
  ),
  -- Un solo escaneo del radio. El filtro de la calle principal va DENTRO:
  -- las columnas caras (distancia, lat/lng, cruces normalizados) solo se
  -- computan para las filas que sobreviven.
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
    FROM street_intersections si, params p
    WHERE ST_DWithin(si.intersection_point, ST_SetSRID(ST_MakePoint(p_lng,p_lat),4326)::geography, p_radius_m)
      AND (lower(unaccent(si.main_street)) LIKE '%'||p.qm||'%'
           OR similarity(lower(unaccent(si.main_street)), p.qm_core) > 0.3)
  ),
  scored AS MATERIALIZED (
    SELECT n.*,
      (n.nc1 LIKE '%'||p.qc1||'%' OR similarity(n.nc1, p.qc1_core) > 0.3) AS mc1,
      (p_cross2 IS NOT NULL
        AND (n.nc1 LIKE '%'||p.qc2||'%' OR similarity(n.nc1, p.qc2_core) > 0.3)) AS mc2,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL
        AND (n.nc2 LIKE '%'||p.qc1||'%' OR similarity(n.nc2, p.qc1_core) > 0.3)) AS m2c1,
      (p_cross2 IS NOT NULL AND n.cross_street_2 IS NOT NULL
        AND (n.nc2 LIKE '%'||p.qc2||'%' OR similarity(n.nc2, p.qc2_core) > 0.3)) AS m2c2,
      (' '||regexp_replace(n.nm,  '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qm_words||'%'
        OR ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qc1_words||'%'
        OR (p_cross2 IS NOT NULL
            AND ' '||regexp_replace(n.nc1, '[^a-z0-9]+', ' ', 'g')||' ' LIKE '%'||p.qc2_words||'%')) AS word_gate
    FROM nearby n CROSS JOIN params p
  ),
  -- Pieza A: la fila que codifica el cruce completo gana, con SU punto.
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
  '00549 v3: "X e/ Y y Z" → coordenadas. (A) una fila que codifica el cruce completo devuelve SU '
  'punto exacto (100/100 esquinas reales a 0 m; la viva daba 85/100 con peor de 1.787 m); (B) gate '
  'de palabra completa — dos trigramas flojos ya no inventan un pin (inexistentes: 10/60 → 1/60); '
  '(C) similarity contra la consulta sin su prefijo genérico, porque "Calle" inflaba el trigrama '
  'entre calles sin relación. Erratas: 70/80 → 80/80.';

-- Andamios de prueba creados a mano en prod para comparar contra la viva.
DROP FUNCTION IF EXISTS public.find_intersection_point_v2c(text, text, text, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.find_intersection_point_v3c(text, text, text, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public._street_core_name_v3c(text);
