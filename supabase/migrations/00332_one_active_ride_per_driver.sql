-- BUG-concurrent-driver: defensive layer 1 — DB-level enforcement
-- that a driver can only have a single active ride at any time.
-- Counterpart to migration 00231 (customer-side, BUG-253).
--
-- The check in `accept_ride_v2` (00142, lines 122-159) is logically
-- correct but NOT atomic — two concurrent transactions on different
-- devices/sessions can both SELECT 0 rows before either UPDATEs, and
-- both UPDATEs succeed because the WHERE filter on rides.status is
-- evaluated against ride1 in T1 and ride2 in T2 (different rows, no
-- mutual exclusion).
--
-- This migration adds a partial UNIQUE INDEX at the storage layer.
-- When two concurrent UPDATEs both try to set driver_id=X on different
-- rides with active status, Postgres serializes them: the first
-- commits; the second raises 23505 unique_violation cleanly.
--
-- Pre-flight verified: 0 drivers currently have >1 active ride (read-only
-- query on prod 2026-05-27), so the constraint applies without cleanup.
--
-- Three mechanisms, mirroring the customer-side defense:
--   1) Partial UNIQUE INDEX — strongest guarantee
--   2) No BEFORE INSERT trigger needed (driver_id is set via UPDATE,
--      never INSERT — `accept_ride_v2` is the only writer)
--   3) Caller in 00333 wraps the UPDATE in EXCEPTION block that maps
--      unique_violation → friendly 'driver_has_active_ride' error
--      that the driver app already handles in useDriverRide.ts:328

CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_per_driver
  ON public.rides (driver_id)
  WHERE driver_id IS NOT NULL
    AND status IN (
      'accepted','driver_en_route',
      'arrived_at_pickup','in_progress','arrived_at_destination'
    );

COMMENT ON INDEX public.rides_one_active_per_driver
  IS 'BUG-concurrent-driver: enforces 1 active ride per driver at the storage layer. Counterpart to rides_one_active_per_customer (00231).';
