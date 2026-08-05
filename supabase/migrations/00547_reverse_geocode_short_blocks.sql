-- ============================================================
-- Migration 00547: el reverse geocode perdía las calles cortas (callejones)
--                  y las etiquetaba con la calle vecina
--
-- WHY (medido contra prod, es el síntoma exacto que reportó un usuario):
--
--   Un pasajero parado en el "Callejón de los Protestantes" veía que la app
--   ponía su recogida en "N e/ calle 9 y calle 11". Eso NO es un pin movido:
--   Calle N ∩ Calle 11 está a 21 m del callejón y Calle N ∩ Calle 9 a 72 m —
--   es la MISMA esquina, mal etiquetada. Pero en La Habana "Calle N e/ 9 y 11"
--   se entiende como la dirección del VEDADO, y ese Calle N está a ~3 km
--   (la esquina Calle N ∩ 13 ∩ Calzada, 3.014 m). De ahí el "casi kilómetro y
--   medio de distancia del punto real" del reporte: la etiqueta manda a otro
--   barrio aunque el pin esté bien.
--
--   Causa raíz: get_nearest_cross_streets (00089) arma "X e/ Y y Z" buscando
--   DOS intersecciones que comparten una calle y están a más de 20 m entre sí
--   — el umbral existe para no decir "X e/ Y y Z" cuando Y y Z son la misma
--   esquina triple (separación 0 m). Pero la cuadra del callejón mide **18,1 m**,
--   apenas por debajo del umbral, así que su par correcto queda descartado y la
--   función cae en el siguiente par que sí pasa: Calle N (cuadra de 58 m).
--
--   Los pares candidatos en ese punto, medidos:
--     San Antonio Chiquito ∩ Callejón  +  Callejón ∩ 1ra   sep  18,1 m  ✗ (>20)
--     Avenida de Colón ∩ Callejón      +  Callejón ∩ 1ra   sep  18,1 m  ✗ (>20)
--     Calle 11 ∩ Calle N               +  Calle N ∩ 13     sep  58,3 m  ✓  ← ganaba
--     Calle 11 ∩ Calle N               +  Calle 9 ∩ Calle N sep 54,1 m  ✓  ← "N e/ 11 y 9"
--
--   Es un sesgo contra exactamente el tipo de calle del reporte: un callejón
--   es corto por definición.
--
-- WHAT THIS DOES:
--   Baja el umbral de separación de 20 m a 8 m. Nada más.
--
--   Con 8 m el punto del callejón resuelve a
--     "Callejón de los Protestantes e/ Avenida de Colón y 1ra"
--   y los pares de 0 m (misma esquina triple), que es lo que el umbral
--   protegía, se siguen rechazando.
--
-- BLAST RADIUS (medido, no estimado):
--   Muestra de 300 puntos reales de street_intersections: cambian **3
--   etiquetas (1 %)**, y las 3 son mejoras estrictas — antes nombraban una
--   calle sobre la que el punto NO está, ahora nombran la correcta:
--     Concha            ← decía "Calle 31"
--     Carretera de Pilón ← decía "B"
--     Calzada de Managua ← decía "Fernando"
--   Cero casos donde la etiqueta vieja fuera la correcta y la nueva no.
--   Cero puntos que pasaran de resolver a no resolver.
--
-- WHAT STAYS:
--   Firma, columnas devueltas y todo el resto del cuerpo idénticos a 00089:
--   dedupe por par de calles, ranking por distancia, elección del par por
--   menor total_dist, radio configurable (los clientes llaman con 150 m).
--   Sigue siendo el mismo criterio "dos esquinas de una cuadra", solo que
--   ahora una cuadra de 18 m también cuenta como cuadra.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_nearest_cross_streets(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer DEFAULT 200
)
RETURNS TABLE(main_street text, cross_streets text[], municipality text, province text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  WITH nearby AS (
    -- Get closest intersections, deduplicated by street pair
    SELECT DISTINCT ON (
      LEAST(si.main_street, si.cross_street_1),
      GREATEST(si.main_street, si.cross_street_1)
    )
      si.main_street,
      si.cross_street_1,
      si.municipality,
      si.province,
      si.intersection_point,
      ST_Distance(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) as dist
    FROM street_intersections si
    WHERE ST_DWithin(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    ORDER BY
      LEAST(si.main_street, si.cross_street_1),
      GREATEST(si.main_street, si.cross_street_1),
      dist
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY dist) as rn
    FROM nearby
  ),
  -- Find first pair that shares a street AND are at DIFFERENT locations.
  -- 00547: the separation threshold is 8 m, not 20 m. It exists to reject a
  -- pair sitting on the SAME triple intersection (separation 0 m), but at 20 m
  -- it also rejected genuinely short blocks — a callejón is short by
  -- definition — and the function then fell through to a neighbouring street,
  -- labelling the rider's position with a street they are not on. See the
  -- migration header for the measured Callejón de los Protestantes case.
  best_pair AS (
    SELECT
      CASE
        WHEN a.main_street = b.main_street THEN a.main_street
        WHEN a.main_street = b.cross_street_1 THEN a.main_street
        WHEN a.cross_street_1 = b.main_street THEN a.cross_street_1
        WHEN a.cross_street_1 = b.cross_street_1 THEN a.cross_street_1
      END as shared_street,
      CASE
        WHEN a.main_street = b.main_street OR a.main_street = b.cross_street_1
          THEN a.cross_street_1
          ELSE a.main_street
      END as cross_a,
      CASE
        WHEN b.main_street = a.main_street OR b.main_street = a.cross_street_1
          THEN b.cross_street_1
          ELSE b.main_street
      END as cross_b,
      a.municipality,
      a.province,
      a.dist + b.dist as total_dist
    FROM ranked a
    JOIN ranked b ON b.rn > a.rn
    WHERE (
      a.main_street = b.main_street OR
      a.main_street = b.cross_street_1 OR
      a.cross_street_1 = b.main_street OR
      a.cross_street_1 = b.cross_street_1
    )
    -- Must be at different geographic locations (different corners).
    AND ST_Distance(a.intersection_point, b.intersection_point) > 8
    ORDER BY total_dist
    LIMIT 1
  )
  SELECT
    bp.shared_street,
    ARRAY[bp.cross_a, bp.cross_b],
    bp.municipality,
    bp.province
  FROM best_pair bp
  WHERE bp.shared_street IS NOT NULL;
$function$;

COMMENT ON FUNCTION public.get_nearest_cross_streets(double precision, double precision, integer) IS
  '00547: dirección cubana "X e/ Y y Z" para un punto. Busca dos esquinas que comparten una calle '
  'y están a más de 8 m entre sí (era 20 m, que descartaba cuadras cortas y etiquetaba al pasajero '
  'con la calle vecina — caso Callejón de los Protestantes, cuadra de 18,1 m).';
