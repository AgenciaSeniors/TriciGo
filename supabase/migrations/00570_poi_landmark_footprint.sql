-- ============================================================
-- Migration 00570: huella (footprint) para landmarks curados —
--                  el pin parado SOBRE un landmark grande debe decir el
--                  landmark, no su sub-local más cercano
--
-- WHY (medido contra prod, 2026-08-21):
--   Pin en el centro de la Manzana de Gómez → "Rooftop Pool & Bar"
--   (no-admin, ~6-12 m) le gana a "Gran Hotel Manzana Kempinski" (is_admin,
--   confidence 1, ~18-30 m). El hotel es una cuadra entera representada por
--   UN punto; sus amenities llevan puntos propios más cercanos. Con las
--   bandas de 10 m de 00550, el sub-local cae en una banda menor y el
--   landmark pierde — is_admin solo desempata DENTRO de una banda.
--
--   Restricciones medidas antes (NO re-derivar):
--   * Un bonus global de distancia para admins regresiona el control de
--     00550: Parque Céspedes (7 m, no-admin) debe seguir ganándole a
--     Iberostar Grand Trinidad (25 m, admin conf 1). Una constante no puede
--     codificar "algunos landmarks son cuadras, otros edificios comunes".
--   * "Suprimir hoteles no-admin a <=60 m de un hotel admin" fue medido
--     plataforma-wide: 721 suprimidos, la muestra eran casas particulares
--     vecinas legítimas. PROHIBIDO revivirla.
--
-- WHAT THIS DOES:
--   1. cuba_pois.footprint_radius_m (smallint, NULL = sin huella = compor-
--      tamiento actual byte a byte). Solo filas is_admin, tope duro 60 m
--      (CHECK). Criterio de curación, medido contra la línea base viva en 3
--      iteraciones (cada ajuste motivado por una clase de flip real): la
--      ZONA DE INFLUENCIA es r + 10 m (ancho de banda del ranking) y debe
--      caber dentro del cuerpo físico del landmark + su propia acera. Regla
--      práctica: r <= dist(vecino genuino más cercano) − 15 — sin el −15,
--      un pin a 5-7 m de la PUERTA del vecino todavía flipea al landmark
--      (medido: Pastelería Francesa a 6.3 m del pin perdía contra Inglaterra
--      con r=12; con r=10 lo conserva).
--      El círculo debe caer ÍNTEGRO en la propiedad del landmark: ahí
--      cualquier otro punto es un amenity propio o basura mal geocodificada
--      (los landmarks famosos son imanes de basura: "Estadio Latinoamericano"
--      a 9.8 m del Hotel Nacional, "Playa Boca Ciega" a 13.4 m del Iberostar
--      Parque Central).
--   2. lookup_nearest_poi_ranked v3: la distancia pasa a ser EFECTIVA
--      (GREATEST(0, cruda − huella)) en el gather, en las bandas, en el
--      orden y en el distance_m DEVUELTO — esto último es load-bearing: el
--      cliente solo antepone el POI si distance_m <= 20
--      (POI_INCLUSION_THRESHOLD_M en packages/utils/src/geo.ts). Pin dentro
--      de la huella => landmark en banda 0 => is_admin le gana el empate a
--      cualquier sub-local pegado al pin. Desempates finales nuevos:
--      distancia CRUDA (dos admins con efectiva 0 resuelven al punto más
--      cercano, p.ej. Hotel Nacional r=40 vs su propio Cabaret Le Parisien,
--      admin a 30 m dentro de sus jardines) y p.id (POIs apilados en la
--      misma coordenada con la misma confidence quedaban a merced del plan).
--   3. 6 semillas curadas y verificadas una a una contra el vecindario real.
--      NO sembradas, con causa: Hotel Ambos Mundos (no hay bug — su rooftop
--      a 6.8 m siempre comparte banda y is_admin ya gana hoy; un radio útil
--      amenazaría al Gabinete Esteban Salas a 13.3 m), Brisas Guardalavaca
--      (hostales a 19-22 m del punto = patrón de la lección-721), "Parque
--      Central" admin (punto mal ubicado: a 7.5 m del hotel Iberostar, no
--      en el parque), Iberostar Grand Trinidad (caso de control + vecindario
--      basural), Melia Cohiba (fila sucia: tricigo_category='transport').
--
-- MEDIDO (candidata inline vs viva, prod read-only, 2026-08-21; la candidata
-- corre como SELECT inline con las semillas simuladas por CTE — DDL en prod
-- está gateado — y es semánticamente idéntica a esta migración):
--
--   | suite                                          | resultado |
--   |------------------------------------------------|-----------|
--   | 4 pines Manzana (centro, punto del Rooftop,    | viva: "Rooftop Pool & Bar" en los 4; candidata: |
--   |   borde a 30 m, y centro vía radio 120)        | "Gran Hotel Manzana Kempinski", distance_m=0.0  |
--   | 3 controles de 00550 (P. Céspedes/Trinidad,    | idénticos viva=candidata (7.0 / 3.9 / 0.0 m)    |
--   |   La Esquina De Oro, Playa Plaza Caracol)      |                                                 |
--   | 10 pines sobrevivientes, incl. "puerta del     | idénticos viva=candidata — Pastelería Francesa  |
--   |   vecino" (pin a 6.3 m de Pastelería, a 4.9 m  | y Bodeguita conservan su etiqueta (con radios   |
--   |   de Bodeguita)                                | del 1er borrador flipeaban: por eso r=10/r=8)   |
--   | grilla 9×9, paso 15 m, sobre las 6 semillas    | 139 diffs: 100 % ganados por una semilla, 0     |
--   |   (486 pines)                                  | fuera del halo (r+40); tragados = amenities     |
--   |                                                | propios y basura mal geocodificada              |
--   | barrido nacional radio 30 (1.674 pines, todas  | 6 diffs, TODOS empates exactos preexistentes:   |
--   |   las provincias, jitter determinista ±20 m)   | POIs apilados a 0.00 m con la misma confidence  |
--   |                                                | (el ganador vivo depende del plan) → p.id los   |
--   |                                                | estabiliza; 0 diffs relacionados a semillas     |
--   | barrido nacional radio 120 (676 pines)         | 5 diffs, la misma clase de empates apilados;    |
--   |                                                | 0 relacionados a semillas                       |
--   | EXPLAIN ANALYZE caliente, 3 corridas alternadas| candidata 72.4/67.5/66.9 ms vs viva             |
--   |                                                | 67.4/102.0/117.5 ms — paridad dentro del ruido; |
--   |                                                | índice GIST conservado (prefiltro constante)    |
--
-- WHAT STAYS: firma, columnas devueltas, radio por defecto (30 m),
--   is_active, tricigo_category IS NOT NULL, LIMIT 1, bandas de 10 m,
--   is_admin/confidence como desempate. Consumidores sin cambio:
--   packages/utils/src/geo.ts (lookupNearestPoi) y resolve_point_address
--   (00539). El único writer de cuba_pois (import_search_poi) es
--   INSERT-only: no puede pisar la columna. Un sub-local importado a futuro
--   dentro de una huella pierde el empate de banda 0 contra is_admin —
--   el fix es robusto al drift de imports.
-- ============================================================

ALTER TABLE public.cuba_pois ADD COLUMN IF NOT EXISTS footprint_radius_m smallint;

DO $$
BEGIN
  ALTER TABLE public.cuba_pois ADD CONSTRAINT cuba_pois_footprint_radius_chk
    CHECK (footprint_radius_m IS NULL
           OR (is_admin AND footprint_radius_m BETWEEN 1 AND 60));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE '00570: constraint ya existe; nada que hacer';
END $$;

COMMENT ON COLUMN public.cuba_pois.footprint_radius_m IS
  '00570: huella curada del landmark (m). Solo filas is_admin; NULL = sin '
  'huella. La zona de influencia es r + 10 m (ancho de banda del ranking) y '
  'debe caber en el cuerpo fisico del landmark + su acera; regla practica '
  'r <= dist(vecino genuino mas cercano) - 15. Verificar el vecindario '
  'contra la funcion viva ANTES de sembrar (ver 00570). Tope 60 acoplado al '
  'prefiltro constante de lookup_nearest_poi_ranked.';

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
    -- 00570: distancia EFECTIVA a la huella del landmark, no a su punto.
    -- Filas sin huella (footprint_radius_m NULL, todas salvo las curadas):
    -- idéntica a la cruda. Devolverla efectiva es load-bearing: el cliente
    -- solo antepone el POI si distance_m <= 20 (POI_INCLUSION_THRESHOLD_M
    -- en packages/utils/src/geo.ts).
    GREATEST(
      ST_Distance(
        p.location,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END),
      0
    ) AS distance_m
  FROM cuba_pois p
  WHERE p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p.is_active = true
    -- 00570: prefiltro CONSTANTE para que el índice GIST siga sirviendo la
    -- consulta (60 = tope duro del CHECK de footprint_radius_m — mantener
    -- acoplados). El filtro exacto por fila viene después.
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m + 60
    )
    -- 00570: un landmark califica si su HUELLA toca el círculo de búsqueda,
    -- aunque su punto central quede fuera. Filas sin huella: predicado
    -- idéntico al de 00550.
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m + (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END)
    )
    -- 00550: el vocabulario normalizado (poblado al 100 %), no la lista
    -- blanca de categorías crudas estilo OSM, que dejaba fuera al 84,6 %
    -- de los lugares — incluidas todas las playas, hoteles, hospitales e
    -- iglesias.
    AND p.tricigo_category IS NOT NULL
  ORDER BY
    -- 00550: la distancia manda, en bandas de 10 m; is_admin y confidence
    -- desempatan dentro de la banda. 00570: la distancia que banda es la
    -- EFECTIVA — un pin dentro de la huella pone al landmark en banda 0 y
    -- ahí is_admin le gana el empate a cualquier sub-local pegado al pin.
    floor(GREATEST(
      ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
      - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END), 0) / 10),
    p.is_admin DESC,
    p.confidence DESC NULLS LAST,
    GREATEST(
      ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
      - (CASE WHEN p.is_admin THEN COALESCE(p.footprint_radius_m, 0) ELSE 0 END), 0),
    -- 00570: desempates finales DETERMINISTAS: distancia cruda (dos admins
    -- con efectiva 0 resuelven al punto más cercano) y p.id — los imports
    -- apilan POIs distintos en la MISMA coordenada con la misma confidence
    -- (medido: 3 pares a 0.00 m en el barrido nacional) y sin id el ganador
    -- depende del plan de ejecución, no de los datos.
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography),
    p.id
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.lookup_nearest_poi_ranked(double precision, double precision, integer) IS
  '00570: lugar reconocible más cercano a un punto, para anteponerlo a la '
  'dirección. v3: distancia EFECTIVA a la huella curada del landmark '
  '(footprint_radius_m, solo is_admin) — un pin parado sobre la Manzana de '
  'Gómez dice Kempinski, no Rooftop Pool & Bar. Sin huella (NULL, todas las '
  'filas salvo las curadas) el comportamiento es idéntico a 00550.';

-- Semillas: una a una, ancladas a id+name+is_admin para que una fila
-- movida/renombrada en prod convierta el UPDATE en no-op contado, nunca
-- en mis-hit. Radios verificados contra la línea base viva (suite de pines
-- nombrados + barridos — ver header y el plan del 2026-08-21).
DO $$
DECLARE
  v_n int;
  v_total int := 0;
BEGIN
  -- Cuadra entera (Manzana de Gómez); zona de influencia 40 m = bloque +
  -- soportales. Vecino genuino más cercano: parada de bus a 46.7 m.
  UPDATE public.cuba_pois SET footprint_radius_m = 30
    WHERE id = 196627 AND name = 'Gran Hotel Manzana Kempinski' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Promontorio con jardines; nada genuino a <=50 m (todo lo cercano es
  -- venue propio o basura mal geocodificada).
  UPDATE public.cuba_pois SET footprint_radius_m = 40
    WHERE id = 195601 AND name = 'Hotel Nacional de Cuba' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Cuadra entera (L y 23). Fonda La Paila a 39.5 m: 39.5 − 15 => r<=24.
  UPDATE public.cuba_pois SET footprint_radius_m = 23
    WHERE id = 195545 AND name = 'Hotel Habana Libre' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- La Xana a 25.3 m y Bodeguita a 25.4 m: 25.3 − 15 => r<=10. El radio
  -- queda corto respecto del bloque físico a propósito; igual arregla su
  -- núcleo de basura (Cine Payret 8.4 m, Hotel National 11.3 m, etc.).
  UPDATE public.cuba_pois SET footprint_radius_m = 8
    WHERE id = 196691 AND name = 'Iberostar Selection Parque Central' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Pastelería Francesa (vecina real en la misma acera) a 25.1 m: con r=12
  -- un pin a 6.3 m de su puerta todavía flipeaba (medido); r=10 lo conserva.
  UPDATE public.cuba_pois SET footprint_radius_m = 10
    WHERE id = 11242 AND name = 'Hotel Inglaterra' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  -- Santiago de Cuba. Hostal Lena & Linet a 19.8 m; zona de influencia 15 m
  -- = el edificio. Con r=5 su rooftop (8.8 m) queda en banda 0 vía efectiva.
  UPDATE public.cuba_pois SET footprint_radius_m = 5
    WHERE id = 207794 AND name = 'Hotel Casagranda' AND is_admin;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_total := v_total + v_n;

  RAISE NOTICE '00570: % de 6 semillas de huella aplicadas', v_total;
  IF v_total < 6 THEN
    RAISE WARNING '00570: % semillas NO matchearon (fila movida/renombrada en prod) — curar a mano', 6 - v_total;
  END IF;
END $$;
