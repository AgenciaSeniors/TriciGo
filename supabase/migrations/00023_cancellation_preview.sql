-- ============================================================
-- Migration 00023: Cancellation Penalty Preview
-- Read-only version of apply_cancellation_penalty for UI preview
-- ============================================================

CREATE OR REPLACE FUNCTION preview_cancellation_penalty(p_user_id UUID)
RETURNS TABLE(penalty_amount INTEGER, is_blocked BOOLEAN, cancel_count_24h INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_cancel_count_24h INTEGER;
  v_penalty INTEGER := 0;
  v_blocked BOOLEAN := false;
BEGIN
  -- Count cancellations in last 24 hours
  SELECT COUNT(*) INTO v_cancel_count_24h
  FROM cancellation_penalties
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '24 hours';

  -- Progressive penalty (same logic as apply_cancellation_penalty)
  IF v_cancel_count_24h >= 4 THEN
    -- 5th+ cancellation in 24h -> block + 200 CUP
    v_penalty := 20000;
    v_blocked := true;
  ELSIF v_cancel_count_24h >= 2 THEN
    -- 3rd-4th -> 200 CUP
    v_penalty := 20000;
  ELSIF v_cancel_count_24h >= 1 THEN
    -- 2nd -> 100 CUP
    v_penalty := 10000;
  ELSE
    -- 1st -> free
    v_penalty := 0;
  END IF;

  RETURN QUERY SELECT v_penalty, v_blocked, v_cancel_count_24h;
END;
$$;
