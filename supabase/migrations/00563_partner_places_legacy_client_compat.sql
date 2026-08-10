-- 00563_partner_places_legacy_client_compat.sql
--
-- Evita que crear el primer lugar aliado tumbe la app de los usuarios que
-- todavía tienen el bundle anterior al cambio de modelo (00558-00561).
--
-- EL FALLO CONCRETO. El carrusel que está instalado hoy hace, sin guardas:
--
--     {p.benefit_title.toUpperCase()}
--
-- 00561 dejó de devolver `benefit_title`, así que sería `undefined` y eso lanza
-- un TypeError DURANTE EL RENDER del inicio. Y el ErrorBoundary del cliente
-- envuelve la aplicación entera (app/_layout.tsx), no el carrusel: el usuario
-- no vería una tarjeta rota sino la app caída, con un Alert que muestra el
-- stack en crudo.
--
-- POR QUÉ NO SE NOTA TODAVÍA: con cero lugares el carrusel devuelve null y ni
-- llega a renderizar. El fallo aparecería exactamente en el momento de crear el
-- primer lugar — que es lo que queremos hacer.
--
-- POR QUÉ NO ALCANZA CON PUBLICAR EL OTA. El cliente usa
-- `fallbackToCacheTimeout: 0`: arranca con el bundle cacheado y aplica la
-- actualización en el arranque SIGUIENTE. Publicar el OTA no protege a nadie de
-- inmediato, y no hay forma de saber cuándo terminó la ventana. Esto sí: sirve
-- para siempre, incluso para quien tarde semanas en abrir la app dos veces.
--
-- LA FORMA DEL ARREGLO. La RPC vuelve a devolver las tres columnas que el
-- bundle viejo lee, calculadas desde el modelo nuevo. El cliente viejo pinta
-- "-20% EN TU VIAJE" en la píldora naranja — que es, casualmente, el texto que
-- muestra el cliente nuevo — y el cliente nuevo ignora esas columnas y usa
-- `discount_percent`. Nadie ve nada raro.
--
-- CUÁNDO BORRAR ESTO: cuando el bundle anterior a 00558 ya no esté en ninguna
-- parte. No antes, y no hay apuro: son tres columnas calculadas.

DROP FUNCTION IF EXISTS public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT);

CREATE OR REPLACE FUNCTION public.get_nearby_partner_places(
  p_lat   DOUBLE PRECISION,
  p_lng   DOUBLE PRECISION,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, name TEXT, discount_percent NUMERIC, tagline TEXT,
  photo_url TEXT, category TEXT, address TEXT, municipality TEXT,
  phone TEXT, hours TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  distance_m DOUBLE PRECISION,
  -- ── Compatibilidad con el bundle anterior a 00558 (ver cabecera) ──
  benefit_title TEXT,
  benefit_description TEXT,
  has_active_coupon BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_origin GEOGRAPHY;
  v_radius NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN;
  END IF;

  v_origin := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius := get_platform_config_numeric('partner_places_discovery_radius_m', 15000);

  RETURN QUERY
  SELECT pp.id, pp.name, pp.discount_percent, pp.tagline,
         pp.photo_url, pp.category, pp.address, pp.municipality,
         pp.phone, pp.hours,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         ST_Distance(pp.location, v_origin),
         -- El cliente viejo hace .toUpperCase() sobre esto: NUNCA puede ser NULL.
         '-' || round(pp.discount_percent)::TEXT || '% en tu viaje',
         -- Se renderiza como texto suelto; un NULL no rompería, pero deja la
         -- tarjeta coja. El tagline si existe, y si no una línea que explica el
         -- beneficio con las palabras del modelo nuevo.
         COALESCE(NULLIF(pp.tagline, ''), 'Tu viaje hasta aquí sale más barato'),
         -- Los cupones ya no existen; el cliente viejo solo lo usa para decidir
         -- si pinta una línea extra.
         false
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_origin, v_radius)
  ORDER BY ST_Distance(pp.location, v_origin)
  LIMIT GREATEST(COALESCE(p_limit, 10), 1);
END;
$$;

REVOKE ALL ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT)
  TO authenticated;

COMMENT ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) IS
  '00563 Devuelve benefit_title/benefit_description/has_active_coupon calculados SOLO para que el bundle anterior a 00558 no lance undefined.toUpperCase() en el render del inicio. Borrar cuando ese bundle ya no exista.';
