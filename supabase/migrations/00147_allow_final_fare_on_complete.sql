-- ============================================================
-- Migration 00147: allow final_fare change on the complete-flow pattern
--
-- Same shape as migration 00144: `enforce_ride_update_columns`
-- unconditionally blocks final_fare changes outside the legacy
-- `complete_ride` RPC. The new `complete_ride_and_pay` (the RPC
-- that the driver app invokes on "Finalizar viaje") sets
-- final_fare_cup / final_fare_trc as part of the canonical
-- completion flow — but the trigger aborts the transaction
-- before the SECURITY DEFINER function can finish.
--
-- Fix: whitelist the canonical completion pattern. A ride whose
-- status transitions from 'in_progress' or 'arrived_at_destination'
-- to 'completed' and whose final_fare moves from NULL to a value
-- is a legitimate completion — allow it. Every other mutation
-- of final_fare stays blocked.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT is_admin() INTO v_is_admin;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;
  v_is_customer := (OLD.customer_id = v_caller_uid);
  v_is_driver := (OLD.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = OLD.driver_id AND user_id = v_caller_uid
  ));
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;

  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  -- Allow final_fare change ONLY during canonical completion.
  -- Used by complete_ride (v1) and complete_ride_and_pay: sets final_fare
  -- from NULL to a computed value while status transitions to 'completed'
  -- (from in_progress or arrived_at_destination). Every other mutation
  -- of final_fare stays blocked.
  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    IF OLD.final_fare_cup IS NULL
       AND NEW.final_fare_cup IS NOT NULL
       AND OLD.status IN ('in_progress','arrived_at_destination')
       AND NEW.status = 'completed' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
    END IF;
  END IF;

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;
  IF v_is_driver AND NOT v_is_customer THEN
    IF NEW.estimated_fare_cup IS DISTINCT FROM OLD.estimated_fare_cup
       OR NEW.estimated_fare_trc IS DISTINCT FROM OLD.estimated_fare_trc
       OR NEW.estimated_distance_m IS DISTINCT FROM OLD.estimated_distance_m
       OR NEW.estimated_duration_s IS DISTINCT FROM OLD.estimated_duration_s THEN
      RAISE EXCEPTION 'driver cannot modify ride estimates';
    END IF;
    IF NEW.pickup_location::text IS DISTINCT FROM OLD.pickup_location::text
       OR NEW.dropoff_location::text IS DISTINCT FROM OLD.dropoff_location::text
       OR NEW.pickup_address IS DISTINCT FROM OLD.pickup_address
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;
  IF v_is_customer AND NOT v_is_driver THEN
    IF NEW.driver_arrived_at IS DISTINCT FROM OLD.driver_arrived_at
       OR NEW.pickup_at IS DISTINCT FROM OLD.pickup_at
       OR NEW.arrived_at_destination_at IS DISTINCT FROM OLD.arrived_at_destination_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'customer cannot modify driver timestamps';
    END IF;
    IF NEW.actual_distance_m IS DISTINCT FROM OLD.actual_distance_m
       OR NEW.actual_duration_s IS DISTINCT FROM OLD.actual_duration_s THEN
      RAISE EXCEPTION 'customer cannot modify actuals';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
