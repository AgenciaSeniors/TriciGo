-- ============================================================
-- Migration 00550: el reverse geocode ignoraba el 84,6 % de los lugares
--                  por una lista blanca de categorías de la era OSM
--
-- WHY (medido contra prod):
--
--   Un pasajero parado EN la Playa Guardalavaca veía como dirección
--   simplemente "Holguín". Lo mismo en Playa Esmeralda, Playa Rancho Luna,
--   Bahía de Matanzas, Windmill Beach… el nombre del lugar desaparecía aunque
--   el pin estuviera literalmente encima (0 m).
--
--   `lookup_nearest_poi_ranked` —la capa que antepone el nombre de un lugar a
--   la dirección— filtraba con una lista blanca de categorías CRUDAS:
--
--     'amenity','shop','tourism','leisure','historic','healthcare',
--     'office','sport','craft','aeroway','emergency','transport'
--
--   Eso es vocabulario OSM. Pero `cuba_pois` hace tiempo que guarda categorías
--   estilo Google/Foursquare: 'hotel', 'restaurant', 'bar', 'beach',
--   'hospital', 'school', 'church_cathedral', 'landmark_and_historical_building'…
--   Ninguna está en la lista. Resultado medido:
--
--     lugares activos                20.490
--     pasan la lista blanca           3.147
--     EXCLUIDOS                      17.343   (84,6 %)
--
--   Entre los excluidos: 1.425 hoteles, 953 paradas de transporte, 699
--   monumentos, 594 restaurantes, 386 bares, 371 escuelas, 345 iglesias,
--   227 playas, 211 hospitales. O sea, el Hospital Hermanos Ameijeiras no
--   aparecía como referencia de una dirección que está en su puerta.
--
--   La columna correcta ya existe y está poblada al 100 %: `tricigo_category`,
--   con un vocabulario normalizado de 21 valores (hotel, restaurant, museum,
--   transport, shop, school, bar, gov, religion, park, cafe, hospital, beach,
--   supermarket, paladar, embassy, bank, pharmacy, gas_station, atm, other).
--   Todos son referencias legítimas para una dirección.
--
-- WHAT THIS DOES:
--   1. Filtra por `tricigo_category IS NOT NULL` en vez de la lista blanca
--      cruda — el radio ya es estrecho (30 m desde el cliente, 120 m desde
--      resolve_point_address), así que cualquier lugar activo tan cerca es una
--      referencia válida.
--   2. **La DISTANCIA pasa a mandar en el orden.** Esto NO es cosmético: al
--      ampliar el conjunto de candidatos, el `ORDER BY is_admin, confidence,
--      distance` original empezó a traer el hotel de cadena con más confianza
--      a 95 m en vez del lugar de al lado. Medido en la primera iteración:
--        "La Esquina De Oro"  a   4 m  →  "Las Malestas"            a  95 m
--        "Playa Plaza Caracol" a  0 m  →  "Casa Azul Varadero"      a  87 m
--        "Parque Céspedes"    a   7 m  →  "Iberostar Grand Trinidad" a 25 m
--      La distancia se agrupa en bandas de 10 m para que `is_admin` (389
--      lugares curados) y `confidence` sigan desempatando entre lugares que
--      están igual de cerca, sin poder saltarse una banda entera.
--
-- MEDIDO, viva vs candidata, 600 puntos de toda Cuba (450 urbanos de todas las
-- provincias + 150 playas/costa), radio 120 m:
--
--   | métrica                              | viva | nueva |
--   |--------------------------------------|------|-------|
--   | puntos con nombre de lugar           |  84  | **266** |
--   | ganan un nombre que antes no tenían  |   —  | **182** |
--   | PIERDEN el nombre que tenían         |   —  |   **0** |
--   | cambian a un lugar MÁS LEJANO        |   —  |   **0** |
--   | distancia media del lugar elegido    | 63 m | **29 m** |
--
--   Y los casos que motivaron todo resuelven por su nombre: Playa Guardalavaca,
--   Playa Esmeralda, Playa Rancho Luna, Bahía de Matanzas, Corralillo Playa,
--   Windmill Beach — todos devolvían NULL, todos devuelven su nombre.
--
-- WHAT STAYS: firma, columnas devueltas, radio por defecto (30 m), `is_active`,
--   y el LIMIT 1. Solo cambian el filtro de categoría y el orden.
--
-- NOTA: quien consume esto es `resolve_point_address` (00539, backstop de
--   direcciones de rides) y `lookupNearestPoi` en packages/utils/src/geo.ts
--   (reverse geocode del cliente, que además solo antepone el POI si está a
--   ≤20 m — ver POI_INCLUSION_THRESHOLD_M). Ninguno necesita cambio.
-- ============================================================

CREATE OR REPLACE FUNCTION public.lookup_nearest_poi_ranked(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer DEFAULT 30
)
RETURNS TABLE(name text, category text, distance_m double precision)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    p.name,
    p.category,
    ST_Distance(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    ) AS distance_m
  FROM cuba_pois p
  WHERE p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p.is_active = true
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    -- 00550: el vocabulario normalizado (poblado al 100 %), no la lista blanca
    -- de categorías crudas estilo OSM, que dejaba fuera al 84,6 % de los
    -- lugares — incluidas todas las playas, hoteles, hospitales e iglesias.
    AND p.tricigo_category IS NOT NULL
  ORDER BY
    -- 00550: la distancia manda, en bandas de 10 m. Con el conjunto ampliado,
    -- ordenar por confidence antes que por distancia traía la cadena hotelera
    -- de 95 m en vez del lugar de al lado. Las bandas dejan que is_admin y
    -- confidence desempaten entre lugares igual de cerca, sin saltarse una.
    floor(ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) / 10),
    p.is_admin DESC,
    p.confidence DESC NULLS LAST,
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.lookup_nearest_poi_ranked(double precision, double precision, integer) IS
  '00550: lugar reconocible más cercano a un punto, para anteponerlo a la dirección. '
  'Filtra por tricigo_category (la lista blanca anterior era vocabulario OSM y excluía el 84,6 % '
  'de cuba_pois, playas incluidas) y ordena por distancia en bandas de 10 m, no por confidence.';

-- ── La misma clase de defecto en la BÚSQUEDA de lugares ────────────────────
--
-- `search_pois_smart` tiene su propia lista de categorías CRUDAS, esta vez de
-- exclusión, pensada para filtrar geometría de OSM (carreteras, polígonos de
-- uso de suelo, edificios):
--
--   AND p.category NOT IN ('highway','landuse','waterway','building','natural',
--       'barrier','place','man_made','railway','river','lake','fountain')
--
-- Medido: de esas 12 categorías, NUEVE no excluyen ni una fila activa — son
-- vestigios. Las tres que sí excluyen algo (river 96, fountain 70, lake 5,
-- total 171 lugares) contienen destinos cubanos reales mal categorizados en el
-- origen: "Bahía Cabañas" figura como `fountain`, "Cayos Santa María" como
-- `fountain`, "Laguna La Redonda" como `lake`, "Río Yumurí" como `river`,
-- "Bahía Bariay" como `fountain`.
--
-- Síntoma: buscar "Bahía Cabañas" desde 2 km devolvía CERO resultados pese a
-- existir el lugar activo con ese nombre exacto y `name_normalized` correcto.
--
-- Se quitan river/lake/fountain de la exclusión. Las otras nueve se dejan como
-- protección para futuras importaciones — no cuestan nada porque no matchean.
--
-- Patch IN-PLACE sobre el cuerpo vivo, no reescritura verbatim: la función son
-- ~9k caracteres y transcribirla podría perder features en silencio (cf. la
-- regresión de 00124 documentada en CLAUDE.md). Verificado antes de escribir
-- esto: el literal aparece exactamente 1 vez.
DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(
    'public.search_pois_smart(text,double precision,double precision,integer,integer)'::regprocedure
  ) INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '00550: search_pois_smart ausente; se omite el patch';
    RETURN;
  END IF;

  -- Idempotente: si ya no está el literal, el patch ya se aplicó.
  IF position('''railway'', ''river'', ''lake'', ''fountain''' IN v_src) = 0 THEN
    RAISE NOTICE '00550: search_pois_smart ya parcheada; nada que hacer';
    RETURN;
  END IF;

  EXECUTE replace(
    v_src,
    '''railway'', ''river'', ''lake'', ''fountain''',
    '''railway'''
  );
  RAISE NOTICE '00550: search_pois_smart — river/lake/fountain salen de la lista de exclusión (171 lugares)';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00550: search_pois_smart ausente; se omite el patch';
END $patch$;

-- Andamio de pruebas creado a mano en prod para comparar contra la viva.
DROP FUNCTION IF EXISTS public.lookup_nearest_poi_ranked_v2c(double precision, double precision, integer);
