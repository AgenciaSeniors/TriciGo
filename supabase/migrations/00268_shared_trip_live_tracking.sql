-- ============================================================
-- Bug A — Viaje compartido en vivo.
--
-- La página pública de seguimiento (apps/web .../track/share/[token])
-- se suscribía a un canal broadcast `ride-driver-location-${ride.id}`
-- esperando eventos `driver_location`. Pero NADIE publica en ese canal:
--
--   - El loop de GPS del conductor (useDriverLocation.ts) llama
--     driverService.updateDriverPosition() → RPC update_driver_position.
--     Esa ruta NO emite broadcast.
--   - El único emisor de broadcast (driverService.updateLocation) quedó
--     como código muerto tras BUG-275 (el loop migró al RPC atómico).
--
-- Resultado: el marcador del conductor nunca se dibujaba en la página
-- compartida — solo se veía la ruta estática. Y el stepper de estado
-- también estaba congelado porque rideService.subscribeToRide es un
-- no-op desde BUG-277 (realtime deshabilitado por saturación de OkHttp).
--
-- Fix (consistente con la arquitectura post-BUG-277 = polling): un RPC
-- SECURITY DEFINER que la página pública puede pollear por token. Sin
-- canales realtime, sin requests extra en el loop del conductor.
--
-- `update_driver_position` ya inserta una fila fresca por tick de GPS en
-- `ride_location_events`; este RPC simplemente lee la más reciente más
-- el estado del ride, todo en una sola llamada token-gated.
--
-- Nota: get_shared_ride_by_token (BUG-118) ya devuelve pickup_address /
-- dropoff_address en prod — este RPC sólo cubre lo DINÁMICO (estado +
-- posición), que es lo que se pollea cada pocos segundos.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_shared_trip_state(p_token text)
RETURNS TABLE (
  status                    text,
  accepted_at               timestamptz,
  pickup_at                 timestamptz,
  arrived_at_destination_at timestamptz,
  completed_at              timestamptz,
  canceled_at               timestamptz,
  driver_lat                double precision,
  driver_lng                double precision,
  driver_heading            numeric,
  driver_recorded_at        timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    r.status::text,
    r.accepted_at,
    r.pickup_at,
    r.arrived_at_destination_at,
    r.completed_at,
    r.canceled_at,
    -- ride_location_events.location is `geography`; cast to geometry so
    -- ST_Y / ST_X return plain lat / lng. NULL until the first GPS fix.
    ST_Y(le.location::geometry) AS driver_lat,
    ST_X(le.location::geometry) AS driver_lng,
    le.heading                  AS driver_heading,
    le.recorded_at              AS driver_recorded_at
  FROM rides r
  -- Latest GPS sample for this ride (one fresh row per tick). LEFT JOIN
  -- LATERAL so the row is still returned (status only) before the
  -- driver has uploaded any location.
  LEFT JOIN LATERAL (
    SELECT location, heading, recorded_at
    FROM ride_location_events
    WHERE ride_id = r.id
    ORDER BY recorded_at DESC
    LIMIT 1
  ) le ON true
  WHERE r.share_token = p_token
    AND (r.share_token_expires_at IS NULL OR r.share_token_expires_at > NOW())
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_shared_trip_state(text) IS
  'Bug A: privacy-safe poll endpoint for the public share-tracking page. Returns ride status + the latest driver GPS sample by share token. No driver_id exposed. Pairs with get_shared_ride_by_token (static info fetched once).';

GRANT EXECUTE ON FUNCTION public.get_shared_trip_state(text) TO anon, authenticated;
