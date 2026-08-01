-- 00539: Backstop server-side de direcciones inútiles en rides
--
-- INCIDENTE (viaje cd09ba9f, 2026-08-01 21:26 UTC). Un conductor recibió una
-- oferta cuyo origen decía "23.12638, -82.35472" (coordenadas crudas) y cuyo
-- destino decía "Ubicación seleccionada en el mapa". La dejó expirar — con esa
-- tarjeta no se puede decidir — y el pasajero canceló. Causas verificadas:
--   - Origen: "Usar mi ubicación" con GPS en una zona SIN esquinas ni POIs en
--     el radio de 150 m que usa la app (patios del ferrocarril, Habana Vieja)
--     → la app cae al fallback de coordenadas. Hueco de DATOS, no de código.
--   - Destino: picker del mapa con conexión lenta — el reverse geocode del
--     cliente tiene un tope de 3 s y no llegó → texto genérico. Los datos SÍ
--     existían server-side ("Pasaje A e/ Pasaje D y Serafina").
-- La clase ya ocurría (15/07, 18/07, 30/07) — baja frecuencia, nunca reportada.
--
-- FIX: el servidor no tiene el problema del timeout móvil ni el radio corto.
-- Un trigger BEFORE INSERT detecta direcciones inútiles y las recalcula con
-- radio progresivo (150 → 500 → 1000 m) contra street_intersections/cuba_pois,
-- con último recurso municipio+provincia por polígono (cuba_admin_areas).
-- Funciona para TODOS los APK ya instalados, sin rebuild.
--
-- Sentinelas que se consideran "inútiles" (y se intentan mejorar):
--   - NULL / vacío
--   - coordenadas crudas ("23.12638, -82.35472")
--   - 'Ubicación seleccionada en el mapa'  (fallback viejo del picker)
--   - prefijo 'Cerca de '                  (fallback nuevo del cliente por
--     preset local; el servidor lo mejora con la esquina real si puede)
-- Si la resolución no encuentra nada mejor, se conserva lo que mandó la app.
-- Defensivo: cualquier error deja la dirección original y NUNCA bloquea la
-- creación del viaje.

-- ── Resolución de un punto a la mejor dirección disponible ──────────────────
CREATE OR REPLACE FUNCTION public.resolve_point_address(p_point geography)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_lat double precision := ST_Y(p_point::geometry);
  v_lng double precision := ST_X(p_point::geometry);
  v_poi text;
  v_street record;
  v_radius integer;
  v_street_part text;
  v_muni text;
  v_prov text;
BEGIN
  -- 1) POI con nombre a <=120 m (mismo umbral que el cliente, POI_INCLUSION_THRESHOLD_M-ish)
  SELECT name INTO v_poi
  FROM lookup_nearest_poi_ranked(v_lat, v_lng, 120)
  ORDER BY distance_m LIMIT 1;

  -- Municipio por polígono administrativo OFICIAL. Se calcula ANTES porque el
  -- campo municipality de street_intersections trae ruido de OSM (el test del
  -- incidente devolvió "Cojimar" para un punto de Habana Vieja); el polígono
  -- de cuba_admin_areas es autoritativo y gana cuando existe.
  SELECT COALESCE(name_es, name) INTO v_muni
  FROM cuba_admin_areas
  WHERE admin_level = 6 AND ST_Contains(geom::geometry, ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326))
  LIMIT 1;

  -- 2) Esquina más cercana con radio progresivo. 150 m = "estás ahí";
  --    500/1000 m = referencia con prefijo "Cerca de".
  FOREACH v_radius IN ARRAY ARRAY[150, 500, 1000] LOOP
    SELECT * INTO v_street FROM get_nearest_cross_streets(v_lat, v_lng, v_radius) LIMIT 1;
    IF v_street.main_street IS NOT NULL THEN
      v_street_part := v_street.main_street
        || CASE
             WHEN array_length(v_street.cross_streets, 1) >= 2
               THEN ' e/ ' || v_street.cross_streets[1] || ' y ' || v_street.cross_streets[2]
             WHEN array_length(v_street.cross_streets, 1) = 1
               THEN ' y ' || v_street.cross_streets[1]
             ELSE ''
           END;
      IF COALESCE(v_muni, v_street.municipality) IS NOT NULL THEN
        v_street_part := v_street_part || ', ' || COALESCE(v_muni, v_street.municipality);
      END IF;
      RETURN COALESCE(v_poi || ', ', '')
        || CASE WHEN v_radius > 150 THEN 'Cerca de ' ELSE '' END
        || v_street_part;
    END IF;
  END LOOP;

  -- 3) Sin calles cerca: al menos el POI si lo hubo.
  IF v_poi IS NOT NULL THEN
    RETURN v_poi;
  END IF;

  -- 4) Último recurso: municipio (ya resuelto arriba) + provincia por polígono.
  SELECT COALESCE(name_es, name) INTO v_prov
  FROM cuba_admin_areas
  WHERE admin_level = 4 AND ST_Contains(geom::geometry, ST_SetSRID(ST_MakePoint(v_lng, v_lat), 4326))
  LIMIT 1;
  IF v_muni IS NOT NULL OR v_prov IS NOT NULL THEN
    RETURN concat_ws(', ', v_muni, v_prov);
  END IF;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.resolve_point_address(geography) IS
  '00539: mejor dirección disponible para un punto (POI<=120m + esquina 150/500/1000m + municipio). '
  'Usada por el backstop de direcciones de rides. NULL si no hay nada.';

REVOKE ALL ON FUNCTION public.resolve_point_address(geography) FROM PUBLIC, anon, authenticated;

-- ── Trigger BEFORE INSERT ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_backstop_addresses()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  -- coordenadas crudas tipo "23.12638, -82.35472"
  c_coord_re constant text := '^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$';
  v_fixed text;
BEGIN
  IF NEW.pickup_location IS NOT NULL AND (
       NEW.pickup_address IS NULL OR btrim(NEW.pickup_address) = ''
       OR NEW.pickup_address ~ c_coord_re
       OR NEW.pickup_address = 'Ubicación seleccionada en el mapa'
       OR NEW.pickup_address LIKE 'Cerca de %'
     ) THEN
    v_fixed := resolve_point_address(NEW.pickup_location);
    IF v_fixed IS NOT NULL THEN
      NEW.pickup_address := v_fixed;
    END IF;
  END IF;

  IF NEW.dropoff_location IS NOT NULL AND (
       NEW.dropoff_address IS NULL OR btrim(NEW.dropoff_address) = ''
       OR NEW.dropoff_address ~ c_coord_re
       OR NEW.dropoff_address = 'Ubicación seleccionada en el mapa'
       OR NEW.dropoff_address LIKE 'Cerca de %'
     ) THEN
    v_fixed := resolve_point_address(NEW.dropoff_location);
    IF v_fixed IS NOT NULL THEN
      NEW.dropoff_address := v_fixed;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Defensivo: un backstop de labels NUNCA bloquea la creación del viaje.
  RAISE WARNING 'tg_rides_backstop_addresses failed: % %', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_address_backstop ON public.rides;
CREATE TRIGGER trg_rides_address_backstop
  BEFORE INSERT ON public.rides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_rides_backstop_addresses();

COMMENT ON TRIGGER trg_rides_address_backstop ON public.rides IS
  '00539: reescribe pickup/dropoff_address inútiles (coordenadas crudas, fallbacks del cliente) '
  'con la mejor dirección server-side. Ver resolve_point_address().';
