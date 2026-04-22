-- ============================================================
-- Migration 00144: allow driver_id change on the accept-flow pattern
--
-- The trigger `enforce_ride_update_columns` (introduced in 00121)
-- guards `rides.driver_id` with an unconditional RAISE EXCEPTION
-- "cannot modify driver_id (use accept_ride RPC)". It was written
-- when `accept_ride` was the only RPC that needed to set driver_id.
--
-- Migration 00142 added `accept_ride_v2` (atomic accept with
-- server-side fare). v2's UPDATE on `rides.driver_id` trips this
-- trigger, aborts the transaction BEFORE any log_rpc_attempt()
-- call runs — which is why rpc_attempt_log showed 0 entries while
-- the driver app got a P0001 back and surfaced "unknown failure".
--
-- The fix whitelists only the legitimate accept pattern:
--   OLD.driver_id IS NULL
--   AND NEW.driver_id IS NOT NULL
--   AND OLD.status = 'searching'
--   AND NEW.status  = 'accepted'
-- This is the exact shape of both accept_ride (v1) and
-- accept_ride_v2. Every other driver_id change is still rejected.
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

  -- Allow driver_id change ONLY on the canonical accept-flow pattern.
  -- Used by accept_ride (v1) and accept_ride_v2: assigns a driver to a
  -- previously unassigned 'searching' ride while transitioning to 'accepted'.
  -- Every other driver_id mutation stays blocked.
  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL; -- OK — legitimate accept
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
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
