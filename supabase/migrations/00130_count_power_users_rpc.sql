-- ============================================================
-- TriciGo — count_power_users RPC
-- Optimization for the admin /segments page "power users" count.
-- Avoids fetching every ride row client-side just to count unique
-- customers with >N rides. Page has a fallback so it keeps working
-- if this RPC is missing, but this is the fast path.
-- ============================================================

CREATE OR REPLACE FUNCTION count_power_users(min_rides INTEGER DEFAULT 10)
RETURNS TABLE(count BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::BIGINT AS count
  FROM (
    SELECT customer_id
    FROM rides
    WHERE customer_id IS NOT NULL
    GROUP BY customer_id
    HAVING COUNT(*) > min_rides
  ) AS power_riders;
$$;

GRANT EXECUTE ON FUNCTION count_power_users(INTEGER) TO authenticated;
