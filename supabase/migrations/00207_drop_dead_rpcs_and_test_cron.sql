-- ============================================================
-- BUG-XXX: dead RPC cleanup + test-data cron in production.
--
-- BUG-X (dead RPCs, defense-in-depth): six RPC functions are
-- granted EXECUTE to authenticated but called from nowhere — not
-- from the apps, not from cron, not from other RPCs. Each one is
-- attack surface that pinning search_path (00206) doesn't fully
-- close: a future RLS regression or rights-grant change could
-- expose them. Drop the dead ones.
--
-- Dead RPCs to drop:
--   - accept_ride(uuid, uuid)            — superseded by accept_ride_v2
--   - apply_cancellation_penalty(uuid, integer, uuid) — 3-arg
--     overload, only 2-arg version is called
--   - find_intersection_point(...)       — never called
--   - import_overpass_pois(...)          — one-time admin import,
--     not used at runtime
--   - mark_stale_drivers_offline(int)    — superseded by inline
--     cron command in `auto-offline-stale-drivers`
--   - nearest_poi(...)                   — never called from app
--
-- BUG-165 (test cron in prod): the `keep-test-drivers-online`
-- cron job runs every 5 minutes in production and keeps three
-- hardcoded test driver profile IDs perpetually online with
-- fixed coordinates near central Havana. A real customer who
-- requests a ride near those coords will be matched against test
-- drivers that don't exist in real life. Drop the cron — test
-- drivers shouldn't be force-onlined on prod.
-- ============================================================

DROP FUNCTION IF EXISTS public.accept_ride(uuid, uuid);
DROP FUNCTION IF EXISTS public.apply_cancellation_penalty(uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.find_intersection_point(text, text, text, double precision, double precision, integer);
DROP FUNCTION IF EXISTS public.import_overpass_pois(text, text, text, text);
DROP FUNCTION IF EXISTS public.mark_stale_drivers_offline(integer);
DROP FUNCTION IF EXISTS public.nearest_poi(double precision, double precision, integer);

-- Drop the test-only cron that's running on production.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'keep-test-drivers-online') THEN
    PERFORM cron.unschedule('keep-test-drivers-online');
  END IF;
END $$;
