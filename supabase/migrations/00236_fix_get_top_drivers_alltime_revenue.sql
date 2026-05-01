-- ============================================================
-- Fix: get_top_drivers RPC — admin Earnings page showed revenue=0
--   for drivers with valid lifetime rides
-- ============================================================
-- Two coupled bugs in the original RPC (00045_analytics_rpcs.sql):
--
-- 1. `rides_count` was read from `dp.total_rides` (a stale counter)
--    while `revenue` was computed from the rides table — so the two
--    columns talked about different drivers/datasets.
--
-- 2. The revenue join filtered to `r.created_at >= CURRENT_DATE - 30`
--    even though the page header reads "más facturación" (no time
--    window). Drivers whose only rides were >30 days old showed
--    rides_count = 200 with revenue = 0.
--
-- Fix: derive both rides_count and revenue from the same rides
-- aggregate, drop the 30-day filter, and order by revenue (matches
-- the page copy "Top 10 por ingresos brutos"). Return shape is
-- unchanged so the TypeScript caller in apps/admin needs no edits.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_top_drivers(p_limit integer DEFAULT 10)
RETURNS TABLE(driver_id uuid, driver_name text, rides_count bigint, rating numeric, revenue numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    dp.id AS driver_id,
    u.full_name AS driver_name,
    COALESCE(COUNT(*) FILTER (WHERE r.status = 'completed'), 0) AS rides_count,
    dp.rating_avg AS rating,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.user_id
  LEFT JOIN rides r ON r.driver_id = dp.id
  WHERE dp.status = 'approved'
  GROUP BY dp.id, u.full_name, dp.rating_avg
  ORDER BY revenue DESC, rides_count DESC
  LIMIT p_limit;
$function$;
