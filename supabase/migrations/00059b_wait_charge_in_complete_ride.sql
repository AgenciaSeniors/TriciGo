-- ============================================================
-- Migration: Add wait time charge calculation to ride completion
-- Updates the complete_ride_and_pay() function to include wait penalty
-- ============================================================

-- Create a helper function for wait time calculation
CREATE OR REPLACE FUNCTION calculate_wait_charge(
  p_ride_id UUID
) RETURNS RECORD AS $$
DECLARE
  v_ride rides%ROWTYPE;
  v_svc service_type_configs%ROWTYPE;
  v_wait_seconds NUMERIC;
  v_wait_minutes INTEGER;
  v_billable_minutes INTEGER;
  v_charge INTEGER;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type;

  -- Calculate wait time (from driver_arrived_at to pickup_at)
  IF v_ride.driver_arrived_at IS NOT NULL AND v_ride.pickup_at IS NOT NULL THEN
    v_wait_seconds := EXTRACT(EPOCH FROM (v_ride.pickup_at::timestamptz - v_ride.driver_arrived_at::timestamptz));
    v_wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::INTEGER);
    v_billable_minutes := GREATEST(0, v_wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
    v_charge := v_billable_minutes * COALESCE(v_svc.per_wait_minute_rate_cup, 0);
  ELSE
    v_wait_minutes := 0;
    v_billable_minutes := 0;
    v_charge := 0;
  END IF;

  -- Update the ride with wait time info
  UPDATE rides SET
    wait_time_minutes = v_wait_minutes,
    wait_time_charge_cup = v_charge
  WHERE id = p_ride_id;

  SELECT v_wait_minutes AS wait_minutes, v_billable_minutes AS billable_minutes, v_charge AS charge INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
