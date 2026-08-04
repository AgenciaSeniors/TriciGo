-- ============================================================
-- Migration 00546: el backstop de direcciones también atrapa los textos
--                  provisionales de la UI
--
-- WHY:
--   00539 puso un backstop BEFORE INSERT que reescribe direcciones inútiles
--   con la mejor dirección server-side. Su lista de sentinelas cubre NULL,
--   vacío, coordenadas crudas, 'Ubicación seleccionada en el mapa' y el
--   prefijo 'Cerca de ' — pero NO los textos provisionales que la app escribe
--   mientras geocodifica o cuando no tiene nada mejor que poner.
--
--   Verificado en prod: "Detectando dirección..." quedó guardado como
--   pickup_address en viajes reales (b98666c6 12/07, 05ed38b0 15/07,
--   30fec440 20/07, 9d1cea91 y 7e866819 30/07). El conductor recibe una
--   oferta cuyo origen dice literalmente "Detectando dirección..." — con esa
--   tarjeta no se puede decidir, que es exactamente el problema que 00539
--   quiso cerrar.
--
--   Origen de cada string (todos son fallbacks, no direcciones):
--     'Detectando dirección...'  apps/client/app/(tabs)/index.tsx:1980
--                                (t('home.detecting_address'), placeholder
--                                mientras corre el reverse geocode)
--     'Origen' / 'Destino'       apps/client/app/(tabs)/index.tsx:929,932
--                                (WebHomeScreen manda esto si el estado de
--                                dirección todavía está vacío)
--     'Mi ubicación'             apps/client/app/(tabs)/index.tsx:743,1031
--                                (fallback de "usar mi ubicación")
--
--   El placeholder está traducido, así que se listan las tres variantes de
--   packages/i18n/src/locales/{es,en,pt}/web.json — un pasajero con la app en
--   inglés manda "Detecting address...".
--
-- WHAT THIS DOES:
--   Extrae la lista de sentinelas a un helper IMMUTABLE
--   `_ride_address_is_placeholder(text)` (una sola fuente de verdad, agregar
--   uno nuevo es una línea) y reescribe tg_rides_backstop_addresses() para
--   usarlo en ambos lados.
--
-- WHAT STAYS:
--   - resolve_point_address() intacta (00539): POI <=120 m, esquina con radio
--     progresivo 150/500/1000 m, último recurso municipio+provincia.
--   - El trigger sigue siendo BEFORE INSERT y solo toca el TEXTO; jamás
--     pickup_location / dropoff_location.
--   - Defensivo: EXCEPTION WHEN OTHERS → RETURN NEW. Un backstop de labels
--     NUNCA bloquea la creación del viaje.
--   - Si resolve_point_address no encuentra nada mejor, se conserva lo que
--     mandó la app (mejor un placeholder que un NULL).
--
-- NOTA: esto es la red de seguridad del servidor y funciona para todos los
--   APK ya instalados. El arreglo en origen (no dejar que la app mande el
--   placeholder) va aparte en apps/client, y requiere rebuild.
-- ============================================================

-- ── Sentinelas: direcciones que no son direcciones ──────────────────────────
CREATE OR REPLACE FUNCTION public._ride_address_is_placeholder(p_addr text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    p_addr IS NULL
    OR btrim(p_addr) = ''
    -- coordenadas crudas tipo "23.12638, -82.35472"
    OR p_addr ~ '^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$'
    -- fallback viejo del picker de mapa
    OR p_addr = 'Ubicación seleccionada en el mapa'
    -- fallback del cliente por preset local (el servidor lo mejora si puede)
    OR p_addr LIKE 'Cerca de %'
    -- 00546: textos provisionales de la UI (es / en / pt)
    OR btrim(p_addr) IN (
         'Detectando dirección...',
         'Detecting address...',
         'Detectando endereço...',
         'Origen',
         'Destino',
         'Mi ubicación'
       );
$function$;

COMMENT ON FUNCTION public._ride_address_is_placeholder(text) IS
  '00546: TRUE si el texto no es una dirección utilizable (vacío, coordenadas crudas, '
  'o un placeholder de la UI). Fuente única de la lista para el backstop de rides.';

REVOKE ALL ON FUNCTION public._ride_address_is_placeholder(text) FROM PUBLIC, anon, authenticated;


-- ── Trigger BEFORE INSERT (00539) usando el helper ──────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_backstop_addresses()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_fixed text;
BEGIN
  IF NEW.pickup_location IS NOT NULL
     AND _ride_address_is_placeholder(NEW.pickup_address) THEN
    v_fixed := resolve_point_address(NEW.pickup_location);
    IF v_fixed IS NOT NULL THEN
      NEW.pickup_address := v_fixed;
    END IF;
  END IF;

  IF NEW.dropoff_location IS NOT NULL
     AND _ride_address_is_placeholder(NEW.dropoff_address) THEN
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

COMMENT ON TRIGGER trg_rides_address_backstop ON public.rides IS
  '00539/00546: reescribe pickup/dropoff_address inútiles (coordenadas crudas, fallbacks del '
  'cliente, placeholders de la UI) con la mejor dirección server-side. '
  'Ver _ride_address_is_placeholder() y resolve_point_address().';
