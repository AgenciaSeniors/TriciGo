-- ============================================================
-- Migration 00126: Ride offers auto re-dispatch
--
-- Closes the loop where the initial batch of 10 offers (migration
-- 00120) expires with nobody accepting. Previously the ride sat
-- silently until the 120s stale-ride cron killed it. Now we retry
-- dispatch up to 2 more times (3 total rounds) with expanding
-- radius, then cancel with reason 'no_drivers_accepted'.
--
-- Round 1: 5000m  (initial, fired by trg_on_ride_insert_dispatch)
-- Round 2: 7500m
-- Round 3: 10000m
-- ============================================================

-- ---- 1. New tracking columns on rides ----
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS dispatch_round int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_dispatched_at timestamptz;

CREATE INDEX IF NOT EXISTS rides_searching_retry_idx
  ON rides (last_dispatched_at)
  WHERE status = 'searching' AND dispatch_round < 3;

-- ---- 2. Extend dispatch_ride with radius param + round tracking ----
DROP FUNCTION IF EXISTS public.dispatch_ride(uuid);
DROP FUNCTION IF EXISTS public.dispatch_ride(uuid, integer);

CREATE OR REPLACE FUNCTION public.dispatch_ride(
  p_ride_id   uuid,
  p_radius_m  integer DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride        rides%ROWTYPE;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_is_delivery boolean;
  v_count       int := 0;
  v_round       int;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');
  v_round := v_ride.dispatch_round + 1;

  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + interval '30 seconds'
  FROM find_best_drivers(v_pickup_lat, v_pickup_lng, v_ride.service_type, 10, p_radius_m, v_is_delivery) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE rides
    SET dispatch_round = v_round,
        last_dispatched_at = now()
  WHERE id = p_ride_id;

  -- On first round with zero matches, cancel immediately (no drivers in area).
  -- On later rounds with zero matches, DON'T cancel — the retry cron will
  -- escalate radius or give up after round 3.
  IF v_count = 0 AND v_round = 1 THEN
    UPDATE rides
      SET status = 'canceled',
          canceled_at = now(),
          cancellation_reason = 'no_drivers_available'
    WHERE id = p_ride_id AND status = 'searching';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'offers_created', v_count,
    'dispatch_round', v_round,
    'radius_m', p_radius_m
  );
END;
$$;

-- ---- 3. retry_dispatch_expired_rides() — called by pg_cron ----
CREATE OR REPLACE FUNCTION public.retry_dispatch_expired_rides()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  r record;
  v_next_radius int;
  v_processed   int := 0;
BEGIN
  -- Loop over searching rides whose offers have all expired (or never got any
  -- after round >=1) AND it's been at least 30s since last dispatch.
  FOR r IN
    SELECT id, dispatch_round
    FROM rides
    WHERE status = 'searching'
      AND dispatch_round >= 1
      AND dispatch_round < 3
      AND last_dispatched_at < now() - interval '30 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM ride_offers o
        WHERE o.ride_id = rides.id
          AND o.status = 'pending'
          AND o.expires_at > now()
      )
  LOOP
    -- Round 2 → 7500m, Round 3 → 10000m
    v_next_radius := CASE r.dispatch_round
      WHEN 1 THEN 7500
      WHEN 2 THEN 10000
      ELSE 10000
    END;
    PERFORM dispatch_ride(r.id, v_next_radius);
    v_processed := v_processed + 1;
  END LOOP;

  -- Cancel rides that exhausted all 3 rounds without any accept.
  UPDATE rides
    SET status = 'canceled',
        canceled_at = now(),
        cancellation_reason = 'no_drivers_accepted'
  WHERE status = 'searching'
    AND dispatch_round >= 3
    AND last_dispatched_at < now() - interval '30 seconds'
    AND NOT EXISTS (
      SELECT 1 FROM ride_offers o
      WHERE o.ride_id = rides.id
        AND o.status = 'pending'
        AND o.expires_at > now()
    );

  RETURN v_processed;
END;
$$;

-- ---- 4. Schedule the retry cron ----
DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'retry-dispatch-expired-rides';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'retry-dispatch-expired-rides',
  '*/1 * * * *',  -- every minute (pg_cron minimum)
  $cron$SELECT retry_dispatch_expired_rides();$cron$
);

-- ---- 5. Back-fill dispatch_round for existing searching rides ----
-- Anything in 'searching' today didn't have the column. Mark them round=1
-- with current time so the retry cron doesn't immediately retry in bulk.
UPDATE rides
  SET dispatch_round = 1,
      last_dispatched_at = COALESCE(last_dispatched_at, created_at)
WHERE status = 'searching' AND dispatch_round = 0;
