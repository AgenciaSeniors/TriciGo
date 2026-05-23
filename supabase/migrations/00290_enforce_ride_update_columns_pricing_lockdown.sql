-- ============================================================
-- CLI-001 (security audit 2026-05-23, Client fare manipulation):
-- enforce_ride_update_columns (BUG-141 / mig 00144 / extended in
-- 00147) protects 5 critical columns from customer/driver tampering:
-- customer_id, driver_id, final_fare_cup/trc, payment_method,
-- cancellation_fee_*. The customer block (lines 96-108 of 00147)
-- also blocks customer-side modification of driver timestamps and
-- actuals.
--
-- BUT the trigger leaves 5 pricing-related columns unprotected for
-- the customer:
--   * surge_multiplier
--   * driver_custom_rate_cup
--   * wallet_ratio
--   * insurance_premium_cup
--   * wait_time_charge_cup
--
-- complete_ride_and_pay (mig 00282) reads these directly from v_ride
-- as source-of-truth for the final fare calculation:
--   v_surge := COALESCE(NULLIF(v_ride.surge_multiplier, 0), ...);
--   v_eff_per_km := COALESCE(v_ride.driver_custom_rate_cup, ...);
--   v_wallet_amount := ROUND(v_final_fare_trc * COALESCE(v_ride.wallet_ratio, 0));
--
-- A customer can therefore execute, between status='accepted' and
-- status='completed':
--
--   supabase.from('rides')
--     .update({ surge_multiplier: 0.01 })
--     .eq('id', myActiveRideId);
--
-- and the completion RPC will compute:
--   v_raw_fare * 0.01 → floored at min_fare
-- so a $5 USD ride becomes ~$0.50 USD. Repeatable per ride.
-- Equivalent vectors via driver_custom_rate_cup=1, wallet_ratio=0
-- (force cash on a tricicoin ride), insurance_premium_cup=0 (when
-- insurance was selected), wait_time_charge_cup=0 (after a long wait).
--
-- The `r_update` policy on rides allows customer UPDATEs on rides
-- they own without column-level restrictions, so RLS doesn't help —
-- only column-level enforcement at trigger time can close this.
--
-- Fix: extend the v_is_customer block of enforce_ride_update_columns
-- to raise on attempted modification of these 5 pricing columns.
-- discount_amount_cup is intentionally NOT included here — it's
-- already guarded by tg_rides_validate_promo_discount (mig 00172),
-- which validates the discount against the promo's max value.
--
-- Admin bypass preserved via is_admin() check at the top of the
-- trigger (unchanged from 00147). Driver-side modifications are
-- not relevant to this finding (drivers have their own fare
-- inflation vectors fixed in DRV-002 / mig 00288 and DRV-003 /
-- mig 00289), but we leave the driver branch unchanged.
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
    -- CLI-001: customer cannot modify the pricing columns that
    -- complete_ride_and_pay (mig 00282) reads as source-of-truth.
    -- See header for the attack vector each one closes.
    IF NEW.surge_multiplier IS DISTINCT FROM OLD.surge_multiplier
       OR NEW.driver_custom_rate_cup IS DISTINCT FROM OLD.driver_custom_rate_cup
       OR NEW.wallet_ratio IS DISTINCT FROM OLD.wallet_ratio
       OR NEW.insurance_premium_cup IS DISTINCT FROM OLD.insurance_premium_cup
       OR NEW.wait_time_charge_cup IS DISTINCT FROM OLD.wait_time_charge_cup THEN
      RAISE EXCEPTION 'customer cannot modify pricing fields (surge_multiplier, driver_custom_rate_cup, wallet_ratio, insurance_premium_cup, wait_time_charge_cup) — these are source-of-truth for complete_ride_and_pay';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_ride_update_columns() IS
  '00147 + CLI-001: trigger function for rides BEFORE UPDATE. Customer block now also rejects modification of surge_multiplier / driver_custom_rate_cup / wallet_ratio / insurance_premium_cup / wait_time_charge_cup (pricing fields read by complete_ride_and_pay).';
