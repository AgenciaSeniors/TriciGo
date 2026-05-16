-- ============================================================
-- BUG-291: ride distance overflow protection — calculate_ride_distance only
--
-- The QA Round 2 ride
--   id 6914bc50-aa89-4eb9-a2b4-140daed62096
--   estimated_distance_m = 1,667
--   actual_distance_m    = 24,619,932  (i.e. 24,619 km)
-- showed that calculate_ride_distance sums haversine across every pair
-- of consecutive ride_location_events rows with no guard against:
--   • NULL location values
--   • (0, 0) sentinel coords (some old Lockito setups leak these)
--   • "teleport" jumps (a single bad sample between two good ones
--     produces a haversine spike on the order of 1000s of km)
-- A single corrupt sample is enough to inflate the sum by 4-5 orders
-- of magnitude.
--
-- The companion fix lives elsewhere (NOT in this migration):
--   • cap_actual_distance_at_1_3x was already deployed and chargeable
--     distance is now LEAST(actual, estimated * 1.3) inside
--     complete_ride_and_pay, so the customer is never billed for the
--     excess. That's why the QA ride only persisted final_fare_cup =
--     1,440 CUP despite actual_distance_m = 24,619,932 — the cap
--     worked, but `actual_distance_m` is still preserved raw for audit.
--   • The 1.3x cap is good DEFENSE, but the SOURCE function is still
--     corrupt — admin tools / batch jobs / future re-runs that consume
--     the raw output keep producing garbage.
--
-- This migration ONLY fixes calculate_ride_distance. It deliberately
-- does NOT touch complete_ride_and_pay (already has the cap +
-- BUG-221 neutral-duration formula `distance_km * 60/40`; rewriting
-- here would risk regressing that).
--
-- The columns rides.excess_distance_uncharged_m and
-- rides.excess_distance_reason are already in prod (added by an
-- earlier migration). The ADD COLUMN IF NOT EXISTS lines below are
-- safe no-ops if so — kept for parity with non-prod envs.
-- ============================================================

-- A) Safety net for non-prod environments that lack the columns.
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS excess_distance_uncharged_m INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excess_distance_reason TEXT;

-- B) Rewrite calculate_ride_distance with defensive filtering.
CREATE OR REPLACE FUNCTION calculate_ride_distance(p_ride_id UUID)
RETURNS TABLE(distance_m INTEGER, point_count INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_distance FLOAT := 0;
  v_count INTEGER := 0;
  v_segment FLOAT;
  v_prev GEOGRAPHY;
  v_curr GEOGRAPHY;
  rec RECORD;
  -- Max plausible distance between two consecutive GPS samples (1 km).
  -- At a 1 s sampling cadence this corresponds to 3,600 km/h — well
  -- beyond any ground vehicle. Anything larger is GPS corruption or a
  -- mock-provider glitch. Skip the bad segment but advance v_prev to
  -- v_curr so the next clean pair still contributes (otherwise a
  -- single bad sample would poison every subsequent segment).
  c_max_segment_m CONSTANT FLOAT := 1000.0;
BEGIN
  FOR rec IN
    SELECT location
    FROM ride_location_events
    WHERE ride_id = p_ride_id
      AND location IS NOT NULL
      -- Filter the (0, 0) sentinel. Legitimate Cuban coords are at
      -- lat ~19.8-23.3, lng ~-85 to -74. ST_X / ST_Y on a geography
      -- return lng / lat in degrees.
      AND NOT (
        ABS(ST_X(location::geometry)) < 0.001
        AND ABS(ST_Y(location::geometry)) < 0.001
      )
    ORDER BY recorded_at ASC
  LOOP
    v_curr := rec.location;
    v_count := v_count + 1;
    IF v_prev IS NOT NULL THEN
      v_segment := ST_Distance(v_prev, v_curr);
      IF v_segment <= c_max_segment_m THEN
        v_distance := v_distance + v_segment;
      END IF;
    END IF;
    v_prev := v_curr;
  END LOOP;

  RETURN QUERY SELECT v_distance::INTEGER AS distance_m, v_count AS point_count;
END;
$$;

COMMENT ON FUNCTION calculate_ride_distance(UUID) IS
  'BUG-291: ignores NULL/(0,0) samples and >1km inter-sample jumps. '
  'Previous version summed every consecutive pair indiscriminately — '
  'a single corrupt sample produced 1000s of km of garbage and '
  'compounded the QA Round 2 incident. Defense-in-depth alongside '
  'the 1.3× chargeable cap already in complete_ride_and_pay.';
