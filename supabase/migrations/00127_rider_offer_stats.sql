-- ============================================================
-- Migration 00127: get_ride_offer_stats RPC for rider searching UI
--
-- Lets the rider see aggregate stats of the offers their ride
-- has generated (how many drivers evaluating, when the earliest
-- pending offer expires, which dispatch round we're on).
--
-- Does NOT expose driver_profile_id — preserves driver privacy.
-- Enforced via auth.uid() check: only the ride's customer can query.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_ride_offer_stats(p_ride_id uuid)
RETURNS TABLE (
  pending_count         integer,
  accepted_count        integer,
  expired_count         integer,
  earliest_expires_at   timestamptz,
  last_dispatched_at    timestamptz,
  dispatch_round        integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_uid uuid;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  -- Only the ride's customer (or admin) may read stats
  IF NOT EXISTS (
    SELECT 1 FROM rides
    WHERE id = p_ride_id
      AND (customer_id = v_caller_uid OR is_admin())
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(COUNT(*) FILTER (WHERE o.status = 'pending' AND o.expires_at > now()), 0)::int,
    COALESCE(COUNT(*) FILTER (WHERE o.status = 'accepted'), 0)::int,
    COALESCE(COUNT(*) FILTER (WHERE o.status = 'expired' OR (o.status = 'pending' AND o.expires_at <= now())), 0)::int,
    MIN(o.expires_at) FILTER (WHERE o.status = 'pending' AND o.expires_at > now()),
    r.last_dispatched_at,
    r.dispatch_round
  FROM rides r
  LEFT JOIN ride_offers o ON o.ride_id = r.id
  WHERE r.id = p_ride_id
  GROUP BY r.last_dispatched_at, r.dispatch_round;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_ride_offer_stats(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ride_offer_stats(uuid) TO authenticated;
