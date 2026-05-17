-- ============================================================
-- Persistent ride search — stop canceling for "no drivers".
--
-- Problem: a ride request with no online drivers was killed in 5
-- places — dispatch_ride() round-1 (instant), retry cron round>=3,
-- auto_cancel_stale (120s), cleanup_orphan (5min) and the client.
--
-- New behaviour: a `searching` ride stays alive while the rider's app
-- keeps it (heartbeat). The retry cron re-dispatches it every minute
-- forever, and a NEW trigger dispatches it the instant a driver comes
-- online. It is only auto-canceled if the rider's app stops sending
-- the heartbeat (abandoned) — or the rider cancels manually.
--
-- See scripts/.../plan: vamos-a-continuar-swirling-graham.
-- ============================================================

-- 1) Rider heartbeat column — bumped by touch_searching_ride() while
--    the rider sits on the "searching" screen. NOT NULL DEFAULT now()
--    so existing rows and freshly-inserted rides start "fresh".
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS searching_seen_at timestamptz NOT NULL DEFAULT now();

-- 2) dispatch_ride() — drop the round-1 zero-drivers auto-cancel.
--    The ride now stays `searching` (offers_created may be 0); the
--    retry cron + the driver-online trigger keep working on it.
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride        rides%ROWTYPE;
  v_pickup_lat  double precision;
  v_pickup_lng  double precision;
  v_is_delivery boolean;
  v_count       int := 0;
  v_round       int;
  v_offer_ttl_s int;
BEGIN
  IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.service_type = 'mensajeria');
  v_round := v_ride.dispatch_round + 1;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    10,
    p_radius_m,
    v_is_delivery,
    v_ride.estimated_distance_m
  ) fbd
  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  -- NOTE: the old `IF v_count = 0 AND v_round = 1` auto-cancel block was
  -- removed here — 0 drivers no longer kills the search.

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s);
END;
$function$;

-- 3) retry_dispatch_expired_rides() — re-dispatch EVERY searching ride
--    with no live offer, forever (no round cap, no cancel). This is
--    what picks up drivers that come online (≤60s safety net).
CREATE OR REPLACE FUNCTION public.retry_dispatch_expired_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_next_radius int;
  v_processed   int := 0;
BEGIN
  FOR r IN
    SELECT id, dispatch_round
    FROM rides
    WHERE status = 'searching'
      AND dispatch_round >= 1
      AND last_dispatched_at < now() - interval '30 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM ride_offers o
        WHERE o.ride_id = rides.id
          AND o.status = 'pending'
          AND o.expires_at > now()
      )
  LOOP
    -- Radius escalates on the first rounds, then stays at the 10 km cap.
    v_next_radius := CASE r.dispatch_round
      WHEN 1 THEN 7500
      ELSE 10000
    END;
    PERFORM dispatch_ride(r.id, v_next_radius);
    v_processed := v_processed + 1;
  END LOOP;

  -- NOTE: the old `dispatch_round >= 3` auto-cancel block was removed —
  -- the search no longer gives up after 3 rounds.

  RETURN v_processed;
END;
$function$;

-- 4) cleanup_orphan_searching_rides() — cancel ONLY abandoned searches
--    (the rider's app stopped heartbeating), not by raw age.
CREATE OR REPLACE FUNCTION public.cleanup_orphan_searching_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_count   INTEGER;
  v_abandon INTEGER;
BEGIN
  -- Configurable abandonment window; default 180s (3 min ~= 6 missed
  -- 30s heartbeats). Tunable via platform_config.searching_abandon_seconds.
  SELECT ((value #>> '{}')::INTEGER) INTO v_abandon
  FROM platform_config WHERE key = 'searching_abandon_seconds';
  v_abandon := COALESCE(v_abandon, 180);

  UPDATE rides
  SET status = 'canceled',
      cancellation_reason = 'searching_abandoned',
      canceled_at = now()
  WHERE status = 'searching'
    AND searching_seen_at < now() - (v_abandon || ' seconds')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- 5) touch_searching_ride() — rider heartbeat RPC. The client calls
--    this every ~30s while on the searching screen.
CREATE OR REPLACE FUNCTION public.touch_searching_ride(p_ride_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  UPDATE rides SET searching_seen_at = now()
  WHERE id = p_ride_id
    AND status = 'searching'
    AND customer_id = auth.uid();
$function$;

COMMENT ON FUNCTION public.touch_searching_ride(uuid) IS
  'Rider heartbeat for a searching ride — keeps the search alive. Only the ride owner can call it.';

GRANT EXECUTE ON FUNCTION public.touch_searching_ride(uuid) TO authenticated;

-- 6) Instant dispatch when a driver comes online — the moment a driver
--    flips is_online=true, offer them every nearby searching ride.
CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_near_driver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
BEGIN
  -- setOnlineStatus updates is_online + current_location together, so
  -- NEW.current_location is normally populated. If not, skip — the
  -- 1-min retry cron will pick the ride up once the location arrives.
  IF NEW.current_location IS NULL THEN RETURN NEW; END IF;

  FOR r IN
    SELECT id FROM rides
    WHERE status = 'searching'
      AND pickup_location IS NOT NULL
      AND ST_DWithin(pickup_location, NEW.current_location, 15000)
  LOOP
    PERFORM dispatch_ride(r.id, 10000);
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a dispatch hiccup break the driver's online toggle.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_dispatch_on_driver_online ON driver_profiles;
CREATE TRIGGER trg_dispatch_on_driver_online
  AFTER UPDATE OF is_online ON driver_profiles
  FOR EACH ROW
  WHEN (NEW.is_online = true AND OLD.is_online IS DISTINCT FROM NEW.is_online)
  EXECUTE FUNCTION dispatch_searching_rides_near_driver();

-- 7) notify_dispatch_retry() — with re-dispatch running every minute
--    forever, the old code pushed "seguimos buscando" every minute.
--    Limit it to rounds 2 and 3 only (two reassurance pushes, then quiet).
CREATE OR REPLACE FUNCTION public.notify_dispatch_retry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service_key TEXT;
  v_headers     JSONB;
  v_body        TEXT;
BEGIN
  IF NEW.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.dispatch_round IS NULL OR OLD.dispatch_round IS NULL THEN RETURN NEW; END IF;
  IF NEW.dispatch_round <= OLD.dispatch_round THEN RETURN NEW; END IF;
  -- Only the first couple of retries notify — re-dispatch now runs
  -- every minute indefinitely, so rounds 4+ stay silent.
  IF NEW.dispatch_round NOT IN (2, 3) THEN RETURN NEW; END IF;
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;

  v_body := CASE NEW.dispatch_round
    WHEN 2 THEN 'Seguimos buscando un conductor cercano. Gracias por tu paciencia.'
    WHEN 3 THEN 'Ampliamos la búsqueda a más conductores. Pronto te confirmamos.'
    ELSE 'Seguimos buscando conductor.'
  END;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := jsonb_build_object(
      'user_id', NEW.customer_id::text,
      'title',   'Buscando conductor',
      'body',    v_body,
      'data', jsonb_build_object(
        'type',           'ride_matching',
        'ride_id',        NEW.id::text,
        'dispatch_round', NEW.dispatch_round
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- 8) Remove the 120s "cancel-stale-rides" cron. The ride no longer
--    times out — auto_cancel_stale_searching_rides() is left as a dead
--    function (no cron references it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cancel-stale-rides') THEN
    PERFORM cron.unschedule('cancel-stale-rides');
  END IF;
END $$;
