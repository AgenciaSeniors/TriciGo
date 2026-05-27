-- BUG-concurrent-driver: defensive layer 4 — diagnostic helper
-- Read-only function that reports drivers with >1 active ride.
-- Useful for ops/dashboard monitoring; if it ever returns rows,
-- the storage-layer UNIQUE INDEX (00332) failed or was bypassed
-- (which should be impossible — alert immediately).
--
-- Also useful pre-migration to validate that no data cleanup is
-- required before applying 00332. (Pre-flight on 2026-05-27
-- returned 0 rows; constraint applied without cleanup.)

CREATE OR REPLACE FUNCTION public.diag_concurrent_driver_rides()
RETURNS TABLE (
  driver_id     uuid,
  count_active  integer,
  ride_ids      uuid[],
  statuses      text[],
  oldest_created timestamptz,
  newest_created timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    r.driver_id,
    COUNT(*)::integer AS count_active,
    ARRAY_AGG(r.id ORDER BY r.created_at) AS ride_ids,
    ARRAY_AGG(r.status::text ORDER BY r.created_at) AS statuses,
    MIN(r.created_at) AS oldest_created,
    MAX(r.created_at) AS newest_created
  FROM rides r
  WHERE r.status IN (
    'accepted','driver_en_route','arrived_at_pickup',
    'in_progress','arrived_at_destination'
  ) AND r.driver_id IS NOT NULL
  GROUP BY r.driver_id
  HAVING COUNT(*) > 1;
$$;

-- Only admins should run this — it exposes internal ride coupling
REVOKE EXECUTE ON FUNCTION public.diag_concurrent_driver_rides() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.diag_concurrent_driver_rides() TO service_role;

COMMENT ON FUNCTION public.diag_concurrent_driver_rides() IS
  'BUG-concurrent-driver diagnostic: returns drivers with >1 active ride. Should always return 0 rows after migration 00332. Service-role only.';
