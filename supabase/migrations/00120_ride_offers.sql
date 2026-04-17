-- ============================================================
-- Migration 00120: Ride offers architecture
--
-- Binds driver matching to acceptance authorization and restores
-- driver discovery that was broken by 00064 (which removed
-- status='searching' from r_select_driver policy, leaving
-- getSearchingRides() returning 0 rows in prod).
--
-- New flow:
--   1. Rider creates ride (status='searching')
--   2. AFTER INSERT trigger calls dispatch_ride()
--   3. dispatch_ride() calls find_best_drivers() and inserts one
--      row per candidate into ride_offers with 30s expiry
--   4. Drivers see their own pending offers via RLS
--   5. accept_ride requires a valid pending offer
--   6. pg_cron job expires stale offers every 30s
-- ============================================================

-- ---- 1. Table ----
CREATE TABLE IF NOT EXISTS ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_profile_id uuid NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired','superseded')),
  composite_score numeric,
  distance_m double precision,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (ride_id, driver_profile_id)
);

CREATE INDEX IF NOT EXISTS ride_offers_driver_status_idx
  ON ride_offers (driver_profile_id, status, expires_at);
CREATE INDEX IF NOT EXISTS ride_offers_ride_status_idx
  ON ride_offers (ride_id, status);

ALTER TABLE ride_offers ENABLE ROW LEVEL SECURITY;

-- ---- 2. RLS ----
-- Driver sees only their own offers; admin sees all; nobody writes directly.
DROP POLICY IF EXISTS ro_select_driver ON ride_offers;
CREATE POLICY ro_select_driver ON ride_offers FOR SELECT
USING (
  driver_profile_id IN (
    SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())
  )
  OR is_admin()
);

-- No direct INSERT/UPDATE/DELETE — RPCs do everything.
REVOKE INSERT, UPDATE, DELETE ON ride_offers FROM authenticated;

-- ---- 3. dispatch_ride RPC ----
-- Populates ride_offers for a newly-created searching ride.
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride        rides%ROWTYPE;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_is_delivery boolean;
  v_count       int := 0;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');

  -- find_best_drivers signature (per migration 00069+delivery patch):
  --   (p_pickup_lat, p_pickup_lng, p_service_type, p_limit, p_radius_m, p_is_delivery)
  -- Returns columns: id, user_id, distance_m, match_score, rating,
  --                  acceptance_rate, composite
  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + interval '30 seconds'
  FROM find_best_drivers(v_pickup_lat, v_pickup_lng, v_ride.service_type, 10, 5000, v_is_delivery) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- If no drivers matched, auto-cancel the ride early with explicit reason
  IF v_count = 0 THEN
    UPDATE rides
      SET status = 'canceled',
          canceled_at = now(),
          cancellation_reason = 'no_drivers_available'
    WHERE id = p_ride_id AND status = 'searching';
  END IF;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count);
END;
$$;

-- ---- 4. Auto-dispatch trigger ----
CREATE OR REPLACE FUNCTION public.on_ride_insert_dispatch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status = 'searching' THEN
    PERFORM dispatch_ride(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_ride_insert_dispatch ON rides;
CREATE TRIGGER trg_on_ride_insert_dispatch
AFTER INSERT ON rides
FOR EACH ROW
EXECUTE FUNCTION on_ride_insert_dispatch();

-- ---- 5. Update r_select_driver policy ----
-- Drivers can now SELECT rides they have a pending offer for,
-- in addition to rides they're already assigned to.
DROP POLICY IF EXISTS r_select_driver ON rides;
CREATE POLICY r_select_driver ON rides FOR SELECT
USING (
  driver_id IN (
    SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())
  )
  OR EXISTS (
    SELECT 1 FROM ride_offers o
    WHERE o.ride_id = rides.id
      AND o.driver_profile_id IN (
        SELECT id FROM driver_profiles WHERE user_id = (SELECT auth.uid())
      )
      AND o.status = 'pending'
      AND o.expires_at > now()
  )
);

-- ---- 6. Patch accept_ride: require a valid pending offer ----
CREATE OR REPLACE FUNCTION public.accept_ride(
  p_ride_id uuid,
  p_driver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride            rides%ROWTYPE;
  v_driver          driver_profiles%ROWTYPE;
  v_existing_active rides%ROWTYPE;
  v_offer           ride_offers%ROWTYPE;
  v_caller_uid      uuid;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles
    WHERE id = p_driver_id AND user_id = v_caller_uid
  ) THEN
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  -- Idempotency
  IF v_ride.driver_id = p_driver_id AND v_ride.status IN
     ('accepted','driver_en_route','arrived_at_pickup','in_progress') THEN
    RETURN jsonb_build_object('success',true,'ride_id',p_ride_id,'idempotent',true);
  END IF;

  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_already_taken');
  END IF;

  -- NEW: require a valid pending offer to accept
  SELECT * INTO v_offer FROM ride_offers
  WHERE ride_id = p_ride_id
    AND driver_profile_id = p_driver_id
    AND status = 'pending'
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','offer_not_found_or_expired');
  END IF;

  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','driver_not_found');
  END IF;

  IF NOT v_driver.is_online THEN
    RETURN jsonb_build_object('error','driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL
     AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error','driver_stale_heartbeat');
  END IF;

  SELECT * INTO v_existing_active FROM rides
  WHERE driver_id = p_driver_id
    AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    AND id <> p_ride_id
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('error','driver_has_active_ride','active_ride_id',v_existing_active.id);
  END IF;

  -- Atomic accept
  UPDATE rides SET
    driver_id = p_driver_id,
    status = 'accepted',
    accepted_at = now()
  WHERE id = p_ride_id AND status = 'searching';

  -- Mark accepted offer
  UPDATE ride_offers
    SET status = 'accepted', responded_at = now()
  WHERE id = v_offer.id;

  -- Supersede other pending offers for the same ride
  UPDATE ride_offers
    SET status = 'superseded', responded_at = now()
  WHERE ride_id = p_ride_id
    AND id <> v_offer.id
    AND status = 'pending';

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id);
END;
$$;

-- ---- 7. Expiration cron ----
-- pg_cron cannot be scheduled from a migration cleanly unless we use
-- cron.schedule(...). Idempotent: unschedule first if exists.
DO $$
DECLARE
  v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'expire-ride-offers';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END
$$;

SELECT cron.schedule(
  'expire-ride-offers',
  '*/1 * * * *',  -- every minute (pg_cron minimum)
  $$UPDATE ride_offers SET status='expired', responded_at=now()
    WHERE status='pending' AND expires_at < now();$$
);

-- ---- 8. Realtime publication ----
-- Expose ride_offers INSERTs/UPDATEs to subscribed drivers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'ride_offers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ride_offers;
  END IF;
END
$$;
