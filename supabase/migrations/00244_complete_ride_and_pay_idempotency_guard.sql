-- ============================================================
-- complete_ride_and_pay: idempotency guard on driver counter
-- ============================================================
-- Audit Item 1 follow-up (see PR #35 recompute migration). The
-- live complete_ride_and_pay RPC ends with:
--
--   UPDATE driver_profiles
--      SET total_rides_completed = total_rides_completed + 1
--    WHERE id = p_driver_id;
--
-- This +1 fires unconditionally every time the RPC is invoked.
-- The status precondition at the top of the function blocks most
-- accidental re-runs (ride.status must be in_progress or
-- arrived_at_destination), but admin tooling that resets a ride
-- back to in_progress and re-runs the RPC double-counts.
-- Eduardo +2 / Papa +6 in the prod recompute attest to this.
--
-- Fix: replace the bare +1 with a recompute from the rides table,
-- which is provably correct regardless of invocation count and
-- always converges to truth.
--
-- Approach: do the replacement dynamically against the live
-- pg_get_functiondef() output rather than embedding the full
-- ~21KB function source in this migration. This stays robust to
-- future edits to the function body — the migration only depends
-- on the buggy line being present verbatim at apply time.
-- ============================================================

DO $migration$
DECLARE
  v_old_src text;
  v_new_src text;
  v_buggy   text := 'UPDATE driver_profiles SET total_rides_completed = total_rides_completed + 1 WHERE id = p_driver_id;';
  v_fix     text := 'UPDATE driver_profiles SET total_rides_completed = (SELECT COALESCE(count(*), 0)::int FROM rides WHERE driver_id = p_driver_id AND status = ''completed'') WHERE id = p_driver_id;';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_old_src
  FROM pg_proc
  WHERE proname = 'complete_ride_and_pay';

  IF v_old_src IS NULL THEN
    RAISE EXCEPTION 'complete_ride_and_pay not found';
  END IF;

  IF POSITION(v_buggy IN v_old_src) = 0 THEN
    RAISE NOTICE 'complete_ride_and_pay: buggy line not found — already fixed or shape changed; skipping';
    RETURN;
  END IF;

  v_new_src := REPLACE(v_old_src, v_buggy, v_fix);
  EXECUTE v_new_src;
END $migration$;

-- Verification (run after apply):
--   SELECT POSITION('total_rides_completed = total_rides_completed + 1' IN pg_get_functiondef(oid))
--   FROM pg_proc WHERE proname = 'complete_ride_and_pay';
--   -- expected: 0 (the buggy line is gone)
--
--   SELECT POSITION('SELECT COALESCE(count(*), 0)::int FROM rides WHERE driver_id = p_driver_id AND status' IN pg_get_functiondef(oid))
--   FROM pg_proc WHERE proname = 'complete_ride_and_pay';
--   -- expected: > 0 (the recompute is in place)
