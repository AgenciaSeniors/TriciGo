-- ============================================================
-- Migration 00575: geo-verja de entrada — cuba_pois deja de aceptar
--                  lugares que no están en Cuba
--
-- WHY (medido, 2026-08-25):
--   00571 desactivó 744 filas fuera del país, y su Paso 0 evita que el sync
--   las RESUCITE. Pero un INSERT nuevo nace activo por diseño (si no, ningún
--   lugar nuevo aparecería jamás), así que el candado no cubre la ENTRADA.
--   Tras los syncs ya sanos del 23-25/08 quedó la prueba: de las 714 filas
--   fuera-de-polígono que el sync refrescó, 14 están activas — 13 son las
--   costeras que conservamos a propósito, y la 14ª es NUEVA:
--
--     id 214855 "Cayman Brac Heritage House" (overture) — a 125 km de Cuba
--
--   La limpieza se erosiona ~1 fila por sync completo.
--
-- POR QUÉ NO SE TOCA EL BBOX (la solución "obvia" es IMPOSIBLE):
--   El plan era subir el sur del CUBA_BBOX de 19.5 a 19.80 para dejar afuera
--   Cayman Brac (19.66-19.76). Medido contra los polígonos oficiales, eso
--   CORTA territorio cubano real:
--
--     Granma            lat_min 19.6275
--     Guantánamo        lat_min 19.6759
--     Santiago de Cuba  lat_min 19.6759
--
--   Las tres provincias orientales se solapan EN LATITUD con Caimán, y en
--   longitud también (Cuba -85.17..-73.92 contiene el -81.5..-79.5 caimanés).
--   Ningún rectángulo separa ambos territorios. El bbox de descarga se queda
--   como está: su trabajo es bajar menos datos, no decidir qué es Cuba.
--
-- WHAT THIS DOES:
--   1. `cuba_landmask`: Cuba + 2 km de tolerancia costera, SUBDIVIDIDA
--      (ST_Subdivide a 256 vértices) con índice GIST. La subdivisión es lo
--      que hace barato el punto-en-polígono: medido sobre las 19.878 activas,
--      4,2 s contra 47,2 s del ST_DWithin directo sobre los polígonos
--      enteros — 11x, y con Index Scan en el plan.
--      Los 2 km son los MISMOS de 00571: conservan muelles, playas y puntos
--      costeros cuyo pin cae en el agua.
--   2. `refresh_cuba_landmask()`: regenera la máscara si algún día cambian
--      los polígonos de `cuba_admin_areas` (hoy no hay ningún writer).
--   3. `_poi_point_in_cuba(geography)`: el predicado, UNA sola definición
--      (el drift de definiciones de "dentro de Cuba" ya nos mordió una vez).
--   4. Trigger BEFORE INSERT en `cuba_pois` que DESCARTA (RETURN NULL) lo que
--      caiga fuera. Va como trigger y no dentro de los RPC a propósito:
--      cubre las tres puertas de una vez (`bulk_upsert_pois`,
--      `import_search_poi`, `apply_osm_delta_batch`) más cualquier writer
--      futuro, y NO toca sus cuerpos — así no puede perder el candado de
--      `is_active` de 00571 ni el fix de `name_normalized` de 00573.
--      Descarta en silencio (no aborta) para que un lugar de Bahamas no
--      tumbe un sync entero; deja `RAISE LOG` para auditar.
--   5. Desactiva la fila 214855, que ya había entrado.
--
-- ALCANCE DELIBERADO: solo INSERT. Un UPDATE que mueva una fila existente
--   fuera del país no se bloquea — no hay evidencia de esa clase, y abortar
--   ahí obligaría a elegir entre revertir la coordenada o perder la fila.
--   Tampoco hay bypass para is_admin: un POI fuera de Cuba no tiene caso de
--   uso legítimo acá (de hecho 4 de las 744 desactivadas eran admin conf 1).
--
-- MEDIDO (prod, BEGIN…ROLLBACK): 12/12 sondas correctas.
--   DENTRO: Capitolio, Trinidad, Cayo Coco, Cayo Largo del Sur,
--     Guardalavaca, Punta de Maisí, Cabo Cruz y el McDonald's de la base
--     GTMO (los dos últimos son justo lo que el bbox 19.80 habría cortado).
--   FUERA:  Cayman Brac Heritage House, Little Cayman Beach Resort,
--     Bahamas/Long Island.
--   (Un crucero a 1,4 km de la costa da DENTRO: es la tolerancia de 2 km
--   haciendo su trabajo, igual que con un muelle. Criterio de 00571.)
-- ============================================================

SET statement_timeout = '600s';

-- 1) Máscara subdividida ────────────────────────────────────
DROP TABLE IF EXISTS public.cuba_landmask;
CREATE TABLE public.cuba_landmask AS
SELECT ST_Subdivide(
         ST_Buffer(ST_Union(a.geom)::geography, 2000)::geometry, 256) AS geom
FROM public.cuba_admin_areas a
WHERE a.admin_level = 4;

CREATE INDEX idx_cuba_landmask_geom ON public.cuba_landmask USING gist (geom);
ANALYZE public.cuba_landmask;

ALTER TABLE public.cuba_landmask ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cuba_landmask IS
  '00575: Cuba + 2 km (la tolerancia costera de 00571), subdividida a 256 '
  'vertices con GIST — hace el punto-en-poligono ~11x mas barato que ST_DWithin '
  'sobre los poligonos enteros. Derivada de cuba_admin_areas (admin_level=4); '
  'regenerar con refresh_cuba_landmask() si esos poligonos cambian. RLS activa '
  'sin policies (tabla-candado): solo la leen funciones SECURITY DEFINER.';

-- 2) Regeneración ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_cuba_landmask()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $fn$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.cuba_landmask;
  INSERT INTO public.cuba_landmask (geom)
  SELECT ST_Subdivide(ST_Buffer(ST_Union(a.geom)::geography, 2000)::geometry, 256)
  FROM public.cuba_admin_areas a
  WHERE a.admin_level = 4;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  ANALYZE public.cuba_landmask;
  RETURN v_n;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_cuba_landmask() IS
  '00575: regenera cuba_landmask desde cuba_admin_areas. Correr si cambian los '
  'poligonos provinciales (hoy esa tabla no tiene writer).';

-- 3) El predicado, una sola definición ──────────────────────
CREATE OR REPLACE FUNCTION public._poi_point_in_cuba(p_point geography)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.cuba_landmask m
    WHERE m.geom && ST_SetSRID(p_point::geometry, 4326)
      AND ST_Covers(m.geom, ST_SetSRID(p_point::geometry, 4326))
  );
$fn$;

COMMENT ON FUNCTION public._poi_point_in_cuba(geography) IS
  '00575: UNA sola definicion de "esta en Cuba" (incluye los 2 km de tolerancia '
  'costera de 00571). La usa la geo-verja de cuba_pois; reutilizable por '
  'cualquier otro gate en vez de re-hardcodear un bbox — el drift entre '
  'definiciones de "dentro de Cuba" ya causo un incidente.';

-- 4) La verja ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_cuba_pois_geofence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $fn$
BEGIN
  IF NEW.location IS NULL OR public._poi_point_in_cuba(NEW.location) THEN
    RETURN NEW;
  END IF;

  RAISE LOG '00575 geofence: descartado POI fuera de Cuba: % (%, %) source=%',
    NEW.name,
    round(ST_Y(NEW.location::geometry)::numeric, 4),
    round(ST_X(NEW.location::geometry)::numeric, 4),
    NEW.source;
  RETURN NULL;  -- BEFORE INSERT: descarta la fila sin abortar la sentencia
EXCEPTION WHEN OTHERS THEN
  -- Defensivo: la verja NUNCA puede tumbar un sync. Ante un fallo propio
  -- deja pasar la fila — el peor caso es la basura que ya teníamos.
  RAISE WARNING '00575 geofence fallo (% %) — dejando pasar %', SQLSTATE, SQLERRM, NEW.name;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_cuba_pois_geofence ON public.cuba_pois;
CREATE TRIGGER trg_cuba_pois_geofence
  BEFORE INSERT ON public.cuba_pois
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuba_pois_geofence();

COMMENT ON FUNCTION public.tg_cuba_pois_geofence() IS
  '00575: geo-verja de entrada. Descarta (RETURN NULL, sin abortar) todo INSERT '
  'cuyo punto caiga fuera de Cuba+2km. Cubre bulk_upsert_pois, import_search_poi, '
  'apply_osm_delta_batch y cualquier writer futuro sin tocar sus cuerpos — asi no '
  'puede perder el candado de is_active de 00571 ni el fix de 00573.';

-- 5) La fila que ya había entrado ───────────────────────────
DO $cleanup$
DECLARE v_n int;
BEGIN
  UPDATE public.cuba_pois
     SET is_active = FALSE, updated_at = NOW()
   WHERE id = 214855 AND name = 'Cayman Brac Heritage House' AND is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '00575: "Cayman Brac Heritage House" desactivada (n=%)', v_n;
END $cleanup$;
