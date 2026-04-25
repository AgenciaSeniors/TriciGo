-- ============================================================
-- BUG-136: update_driver_score is SECURITY DEFINER, granted EXECUTE
-- to authenticated, with NO authorization check on the caller. A
-- malicious user could drop any driver's match_score to 0
-- (effectively delisting them from dispatch — find_best_drivers
-- requires match_score > 10) by calling:
--
--   supabase.rpc('update_driver_score', {
--     p_driver_id: target_user_id,
--     p_event_type: 'admin_adjustment',
--     p_details: { delta: -100 }
--   });
--
-- They could also boost their own score with positive deltas, fake
-- '5_star_rating' events to inflate their ranking, or spam
-- 'cancel_by_driver' on competitors. Verified end-to-end: under a
-- customer's JWT, called the RPC and observed the target driver's
-- match_score go from 80 → 0. Reverted via service role.
--
-- update_driver_score has two legitimate caller types:
--   1. Admin tooling (admin.service.ts adjustDriverScore)
--   2. Internal triggers on rides — trg_ride_completed_score,
--      trg_ride_canceled_score, the rating triggers, etc.
--
-- For (1), the caller is an admin → is_admin() returns true.
-- For (2), the function runs inside a trigger fire chain — we can
--   detect that with pg_trigger_depth() > 0. PostgreSQL increments
--   trigger depth as the trigger nests, and resets it back to 0
--   between top-level statements. A direct RPC call has depth 0.
--
-- A SECDEF function called inside a trigger inherits the depth, so
-- the check correctly distinguishes "I am being called as a side
-- effect of a legitimate row change" from "a customer is calling
-- me with arbitrary inputs".
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_driver_score(
  p_driver_id uuid,
  p_event_type text,
  p_details jsonb DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_delta DECIMAL;
  v_new_score DECIMAL;
BEGIN
  -- BUG-136: gate direct callers. Triggers (pg_trigger_depth > 0)
  -- and admin tools (is_admin()) bypass.
  IF pg_trigger_depth() = 0 AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: update_driver_score can only be called by admins or by internal triggers';
  END IF;

  CASE p_event_type
    WHEN 'ride_completed' THEN v_delta := 2.0;
    WHEN '5_star_rating' THEN v_delta := 5.0;
    WHEN '4_star_rating' THEN v_delta := 2.0;
    WHEN '3_star_rating' THEN v_delta := 0.0;
    WHEN '2_star_rating' THEN v_delta := -5.0;
    WHEN '1_star_rating' THEN v_delta := -10.0;
    WHEN 'cancel_by_driver' THEN v_delta := -5.0;
    WHEN 'sos_report' THEN v_delta := -20.0;
    WHEN 'tip_received' THEN v_delta := 3.0;
    WHEN 'ride_declined' THEN v_delta := -1.0;
    WHEN 'consecutive_completions_5' THEN v_delta := 5.0;
    WHEN 'admin_adjustment' THEN
      v_delta := COALESCE((p_details->>'delta')::DECIMAL, 0);
    ELSE
      v_delta := 0;
  END CASE;

  IF v_delta = 0 AND p_event_type != 'admin_adjustment' THEN
    RETURN (SELECT match_score FROM driver_profiles WHERE user_id = p_driver_id);
  END IF;

  INSERT INTO driver_score_events (driver_id, event_type, delta, details)
  VALUES (p_driver_id, p_event_type, v_delta, p_details);

  UPDATE driver_profiles
  SET match_score = GREATEST(0, LEAST(100, match_score + v_delta))
  WHERE user_id = p_driver_id
  RETURNING match_score INTO v_new_score;

  RETURN COALESCE(v_new_score, 50.0);
END;
$$;

COMMENT ON FUNCTION public.update_driver_score(uuid, text, jsonb) IS
  'BUG-136: now requires is_admin() OR pg_trigger_depth() > 0. Internal triggers (ride_completed, ride_canceled, ratings) still call it transparently; direct RPC calls from non-admin auth users are rejected.';
