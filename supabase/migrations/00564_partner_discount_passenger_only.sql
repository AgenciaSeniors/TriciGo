-- 00564_partner_discount_passenger_only.sql
--
-- El descuento de lugar aliado deja de aplicarse a la mensajería.
--
-- POR QUÉ. En un envío, quien recibe el paquete es el que está en el negocio y
-- quien ahorra es otro: el incentivo no llega a quien pisa el local, que es lo
-- único que el acuerdo compra. El modelo de cupón excluía la mensajería a
-- propósito (`ride_mode = 'passenger'` en el trigger de emisión); al mudar el
-- cálculo al trigger de descuentos en 00559 esa exclusión se perdió sin que
-- nadie lo decidiera. Esto la restaura.
--
-- DOS LADOS, Y LOS DOS IMPORTAN. El trigger decide lo que se COBRA; la RPC
-- decide lo que se MUESTRA antes de confirmar. Tocar solo el trigger dejaría a
-- la app enseñando un descuento que ya no se aplica, y el pasajero pagaría MÁS
-- de lo que vio — exactamente lo que esta función no puede hacer nunca.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Lo que se cobra: patch in-place del trigger
-- ─────────────────────────────────────────────────────────────────────
-- Patch, no reescritura: el cuerpo tiene ~9k caracteres y gobierna además los
-- promos y el viaje compartido, que están vivos. Partir del cuerpo VIVO es lo
-- que garantiza que no se pierda nada por el camino (cf. la regresión de 00124).
-- Pre-vuelo verificado al escribir esto: 1 sola ocurrencia del literal, y el
-- cuerpo todavía no menciona ride_mode. md5(prosrc) = 0cd4a6cdf8da67ef82ad8a2b334e0115

DO $patch$
DECLARE
  v_src  TEXT;
  v_old  TEXT;
  v_new  TEXT;
  v_hits INT;
BEGIN
  v_old := 'IF NEW.dropoff_location IS NOT NULL AND v_fare_base > 0 THEN';
  v_new := 'IF NEW.dropoff_location IS NOT NULL AND v_fare_base > 0 '
        || 'AND COALESCE(NEW.ride_mode, ''passenger'') = ''passenger'' THEN';

  SELECT pg_get_functiondef(oid) INTO v_src
  FROM pg_proc
  WHERE proname = 'tg_rides_validate_promo_discount' AND pronamespace = 'public'::regnamespace;

  IF v_src IS NULL THEN
    RAISE NOTICE '[00564] tg_rides_validate_promo_discount ausente; se omite';
    RETURN;
  END IF;

  -- Idempotente.
  IF position(v_new IN v_src) > 0 THEN
    RAISE NOTICE '[00564] ya aplicado; sin cambios';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    -- Fallar ruidoso antes que parchear a ciegas: si la guarda cambió de forma,
    -- alguien tiene que mirarla antes de tocar cómo se calcula un descuento.
    RAISE EXCEPTION '[00564] se esperaba 1 ocurrencia de la guarda, se encontraron % — revisar a mano', v_hits;
  END IF;

  EXECUTE replace(v_src, v_old, v_new);
  RAISE NOTICE '[00564] el descuento de lugar aliado quedó limitado a viajes de pasajero';
END $patch$;

-- COALESCE porque una fila sin ride_mode tiene que tratarse como viaje de
-- pasajero, que es el caso por defecto: no perder el descuento por un NULL.

-- ─────────────────────────────────────────────────────────────────────
-- 2. Lo que se muestra: la RPC de display honra el modo
-- ─────────────────────────────────────────────────────────────────────
-- El parámetro lleva valor POR DEFECTO a propósito. El cliente que ya está en
-- la calle llama con tres argumentos; con un default sigue resolviendo contra
-- esta misma función en vez de romperse con PGRST202 y perder el descuento en
-- TODOS los viajes hasta el próximo OTA.
--
-- Cambia la aridad ⇒ DROP con la firma vieja ANTES del CREATE, o Postgres deja
-- una sobrecarga y los llamadores viejos seguirían yendo a la anterior.

DROP FUNCTION IF EXISTS public.get_partner_discount_for_dropoff(
  DOUBLE PRECISION, DOUBLE PRECISION, INTEGER);

CREATE OR REPLACE FUNCTION public.get_partner_discount_for_dropoff(
  p_lat       DOUBLE PRECISION,
  p_lng       DOUBLE PRECISION,
  p_fare_cup  INTEGER,
  p_ride_mode TEXT DEFAULT 'passenger'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pt   GEOGRAPHY;
  v_row  RECORD;
  v_rate NUMERIC;
  v_disc INTEGER;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL OR COALESCE(p_fare_cup, 0) <= 0 THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- 00564: la mensajería no lleva descuento. Misma condición que el trigger,
  -- para que lo mostrado siga coincidiendo con lo cobrado.
  IF COALESCE(p_ride_mode, 'passenger') <> 'passenger' THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  v_pt := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  SELECT pp.id, pp.name, pp.discount_percent
    INTO v_row
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_pt, pp.radius_m)
  ORDER BY ST_Distance(pp.location, v_pt)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Mismo tope que aplica el trigger, para que lo mostrado coincida con lo cobrado.
  v_rate := get_platform_config_numeric('commission_rate', 0.15);
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate >= 1 THEN
    v_rate := 0.15;
  END IF;

  v_disc := GREATEST(LEAST(
    ROUND(p_fare_cup * v_row.discount_percent / 100.0)::INTEGER,
    ROUND(p_fare_cup * v_rate)::INTEGER
  ), 0);

  RETURN jsonb_build_object(
    'found',            v_disc > 0,
    'place_id',         v_row.id,
    'place_name',       v_row.name,
    'discount_percent', v_row.discount_percent,
    'discount_cup',     v_disc
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_partner_discount_for_dropoff(
  DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_partner_discount_for_dropoff(
  DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, TEXT) TO authenticated;

COMMENT ON FUNCTION public.get_partner_discount_for_dropoff(
  DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, TEXT) IS
  '00564 Solo display. p_ride_mode lleva default para no romper al cliente ya desplegado, que llama con 3 argumentos. Lo que se cobra lo escribe tg_rides_validate_promo_discount.';
