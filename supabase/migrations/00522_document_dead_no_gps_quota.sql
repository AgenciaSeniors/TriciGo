-- La "cuota semanal sin GPS" nunca se conectó, y el esquema afirma lo contrario.
--
-- El comentario que hoy tiene rides.no_gps_validation dice:
--
--   "BUG-244: True when driver advanced this ride with GPS unavailable. Counts
--    toward weekly cap (3/week) before auto-suspension."
--
-- Nada de eso existe. Verificado contra producción:
--
--   * NINGUNA función escribe rides.no_gps_validation. La única que la menciona
--     es driver_no_gps_rides_this_week(), que solo la LEE.
--   * driver_no_gps_rides_this_week() no tiene ni un caller (ni SQL ni cliente),
--     y como cuenta filas con no_gps_validation = true, devuelve SIEMPRE 0.
--   * No hay tope de 3/semana, ni auto-suspensión: cero funciones con lógica de
--     suspensión ligada a GPS, cero triggers sobre la columna, cero keys de
--     platform_config relacionadas.
--   * 0 filas con no_gps_validation = true en el histórico completo.
--   * update_ride_status_v2 declara p_no_gps_mode pero su cuerpo NUNCA lo lee
--     (ninguna versión lo hizo), y ningún llamador del cliente lo pasaba.
--
-- El riesgo real es de auditoría, no de runtime: alguien revisando el esquema
-- concluye que los conductores tienen un límite de avances sin GPS y que el
-- sistema los suspende solo. No los tiene y no los suspende. Un control
-- antifraude documentado pero inexistente es peor que uno ausente.
--
-- Lo que SÍ funciona para el GPS roto es otro camino, completo de punta a punta:
--   report_driver_gps_unavailable  -> driver_gps_status = 'unavailable'
--   rider_respond_to_gps_unavailable -> 'rider_consented' (o cancela el viaje)
--   update_ride_status_v2 ve 'rider_consented' y salta la verja de proximidad.
-- (Nunca se ejercitó en producción: 0 viajes llegaron a 'rider_consented'.)
--
-- Esta migración solo corrige documentación. NO dropea la función ni la columna:
-- por convención (CLAUDE.md) lo deprecado se marca primero y se elimina en una
-- segunda pasada, una vez confirmado que no aparecieron callers.
--
-- IMPORTANTE — p_no_gps_mode NO se puede quitar de la firma todavía. PostgREST
-- resuelve por nombres de argumento, así que las apps ya instaladas que siguen
-- mandando p_no_gps_mode dejarían de resolver la función (PGRST202) y NINGÚN
-- conductor podría cambiar el estado de un viaje. Se queda hasta que el parque
-- de APKs haya rotado.

COMMENT ON COLUMN public.rides.no_gps_validation IS
  '00522 MUERTA: ninguna función la escribe; 0 filas true en todo el histórico. '
  'El comentario anterior prometía un tope de 3/semana con auto-suspensión que '
  'NUNCA se implementó (sin trigger, sin función de suspensión, sin config). '
  'Se conserva la columna a la espera de un DROP en segunda pasada. El camino '
  'vivo para GPS roto es driver_gps_status=rider_consented.';

COMMENT ON FUNCTION public.driver_no_gps_rides_this_week(uuid) IS
  '00522 DEPRECADA: sin callers, y lee rides.no_gps_validation, que nadie '
  'escribe, así que devuelve SIEMPRE 0. No usar como control de cuota: daría '
  'vía libre a cualquier conductor. Marcada para DROP en segunda pasada.';

COMMENT ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean) IS
  'BUG-244+246: actualiza el estado del viaje con verja de proximidad (100 m '
  'estricto, 500 m elegible para confirmación del pasajero). El consentimiento '
  'del pasajero (driver_gps_status=rider_consented) salta la verja por completo. '
  '00521: si no hay coordenadas o quedan lejos, acepta como prueba el rastro GPS '
  'del propio viaje (ride_location_events), que es lo que rescata al conductor '
  'que llegó sin cobertura. '
  '00522: p_no_gps_mode es VESTIGIAL — el cuerpo nunca lo leyó. Se mantiene en '
  'la firma SOLO para que las apps ya instaladas que lo envían sigan resolviendo '
  'la función; quitarlo daría PGRST202 y bloquearía todo cambio de estado. '
  'Quitar recién cuando el parque de APKs haya rotado.';
