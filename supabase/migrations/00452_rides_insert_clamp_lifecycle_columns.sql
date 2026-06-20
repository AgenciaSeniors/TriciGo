-- 00452_rides_insert_clamp_lifecycle_columns.sql
-- Auditoría 2026-06-20 SEGUNDA FASE — AUD2-001 + N5 (clase "rides INSERT sub-protegido").
--
-- La RLS de INSERT de `rides` solo chequea `customer_id = auth.uid()`, y TODA la protección de
-- columnas (el state machine `trg_enforce_ride_transition` y el lockdown de pricing CLI-001
-- `enforce_ride_update_columns`) es BEFORE **UPDATE**. Verificado contra prod: un cliente
-- autenticado puede self-INSERTar un ride con un lifecycle FORJADO:
--   * status='completed' → infla el tier (recompute_user_level cuenta rides completados),
--   * driver_id / final_fare_cup / final_fare_trc / actual_* / driver_custom_rate_cup forjados,
-- todas columnas que SOLO el servidor setea durante el ciclo del viaje (accept/complete RPCs),
-- nunca el cliente al crear. (NOTA: surge_multiplier/wallet_ratio/insurance NO se tocan — el cargo
-- usa paridad estricta sobre el snapshot, así que no son vector de robo; y son legítimamente
-- seteados por el cliente al crear / recomputados por su trigger.)
--
-- Fix: extender el BEFORE INSERT `tg_rides_normalize_scheduling` (00451) para forzar las columnas de
-- lifecycle a valores iniciales seguros, SOLO para callers reales (auth.uid() IS NOT NULL).
-- service_role / cron (auth.uid() NULL — create_rides_for_recurring, backfills) quedan exentos
-- (igual insertan en 'searching'). El trigger ya ordena ANTES de trg_enforce_one_active_ride_per_customer.

CREATE OR REPLACE FUNCTION public.tg_rides_normalize_scheduling()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Scheduling (incondicional; correcto para normal/scheduled/recurring). 00451.
  NEW.is_scheduled := (NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now());
  NEW.scheduled_notified := false;

  -- AUD2-001 / N5: clampear las columnas de lifecycle para inserts de cliente real.
  IF auth.uid() IS NOT NULL THEN
    NEW.status                    := 'searching';
    NEW.driver_id                 := NULL;
    NEW.final_fare_cup            := NULL;
    NEW.final_fare_trc            := NULL;
    NEW.accepted_at               := NULL;
    NEW.completed_at              := NULL;
    NEW.canceled_at               := NULL;
    NEW.driver_arrived_at         := NULL;
    NEW.pickup_at                 := NULL;
    NEW.arrived_at_destination_at := NULL;
    NEW.actual_distance_m         := NULL;
    NEW.actual_duration_s         := NULL;
    NEW.driver_custom_rate_cup    := NULL;  -- campo de driver/admin
    NEW.wait_time_charge_cup      := 0;     -- NOT NULL; se acumula durante el viaje
  END IF;

  RETURN NEW;
END;
$$;
-- Trigger rides_normalize_scheduling (00451, BEFORE INSERT) ya cableado; solo se reemplaza el cuerpo.
