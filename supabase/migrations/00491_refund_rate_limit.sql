-- 00491_refund_rate_limit.sql
--
-- Refund one unit of a rate-limit budget for the CURRENT fixed window.
--
-- Why: `check_rate_limit` (00105) increments the counter UNCONDITIONALLY,
-- before the gated action's outcome is known. In `send-sms-otp` the per-phone
-- (send-sms-otp:phone:<E164>) and per-IP (send-sms-otp:<ip>) tokens are spent
-- even when D7 ultimately REJECTS the send (or is misconfigured). A user who
-- never received a code then taps "reenviar" and burns their budget → 429
-- lockout with zero working codes in hand (verified in prod 2026-07-10: the
-- phones that hit the per-phone 429 were the ones failing to receive).
--
-- The budget is meant to throttle *sent* SMS, not provider failures. This RPC
-- lets the caller give a token back when the send did not go out. It recomputes
-- the window boundary with the SAME formula as check_rate_limit so, on the
-- failure path (milliseconds later), it targets the exact same row. If the
-- request straddled a window boundary and the row isn't found, the UPDATE is a
-- safe no-op (the token simply stays consumed — conservative).
--
-- NOTE: does NOT help the "D7 accepts (200 + request_id) but the carrier never
-- delivers" case (ETECSA 6-prefix routing gap) — there ok=true at send time, so
-- no refund fires. That is a D7-side problem; this only refunds hard failures.

CREATE OR REPLACE FUNCTION public.refund_rate_limit(
  p_key TEXT,
  p_window_seconds INTEGER
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
BEGIN
  -- Same window math as check_rate_limit (00105) — fixed/tumbling window.
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  UPDATE rate_limits
    SET count = GREATEST(count - 1, 0)
    WHERE key = p_key
      AND window_start = v_window_start;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refund_rate_limit(TEXT, INTEGER) TO service_role;

-- Verification (read-only smoke, run after apply):
--   SELECT check_rate_limit('refund-test', 5, 300);   -- count=1
--   SELECT refund_rate_limit('refund-test', 300);     -- count back to 0
--   SELECT count FROM rate_limits WHERE key='refund-test';  -- 0
--   DELETE FROM rate_limits WHERE key='refund-test';
