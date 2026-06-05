-- 00379_publish_ride_waypoints_realtime.sql
-- Re-add public.ride_waypoints to the `supabase_realtime` publication.
--
-- ROOT CAUSE (verified against prod 2026-06-04): ride_waypoints was the ONLY
-- ride-related table MISSING from the `supabase_realtime` publication. Its
-- siblings (rides, ride_messages, ride_splits, notifications) are all present.
-- Migration 00029_ride_waypoints.sql:42 DID declare
--   `ALTER PUBLICATION supabase_realtime ADD TABLE ride_waypoints;`
-- so this is a git<->prod DRIFT: the table was later dropped from the
-- publication (most likely a table recreate, which silently removes it from
-- any publication) and never re-added.
--
-- SYMPTOM: the client `waypoints` realtime channel subscribes via
-- postgres_changes on ride_waypoints (rideService.subscribeToWaypoints).
-- Subscribing to a table that is NOT in the realtime publication makes Realtime
-- reject the subscription -> recurring
--   `[realtime] channel "waypoints" CHANNEL_ERROR { error: undefined }`.
-- Multi-stop ("agregar parada") realtime sync has been silently broken in prod,
-- masked only by the authoritative RPC refetch fallback in the consumers:
--   - apps/client/src/components/RideActiveView.tsx (rider)
--   - apps/driver/src/components/DriverTripView.tsx (driver)
--
-- IDEMPOTENT: only adds the table if it is not already published, so this is
-- safe to (re)apply and safe regardless of whether 00029's line is currently
-- in effect on a given environment.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ride_waypoints'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ride_waypoints;
  END IF;
END $$;
