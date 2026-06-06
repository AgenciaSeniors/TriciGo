-- ============================================================
-- Re-dispatch searching rides to a driver who just became free.
--
-- BUG (reported by operator): "I finish a trip and no new ride
-- requests reach the driver until I toggle offline and back online;
-- after reconnecting, the requests come."
--
-- Root cause — an asymmetry in how a driver "becomes available":
--   1. Going online (driver_profiles.is_online false->true) fires
--      trg_dispatch_on_driver_online -> dispatch_searching_rides_near_driver(),
--      which FORCE-offers every nearby `searching` ride to that driver
--      (PERFORM dispatch_ride per ride; ON CONFLICT DO NOTHING).
--   2. Finishing / canceling the active ride ALSO frees the driver, but
--      there was NO equivalent trigger. The freed driver then relied only
--      on retry_dispatch_expired_rides() (1-min cron), which SKIPS any ride
--      that already has a pending offer to another driver (00269 lines
--      105-110) and has up-to-60s latency. So a driver who frees up by
--      completing a trip was frequently NOT re-offered the rides that were
--      waiting/searching — until the manual online toggle force-dispatched
--      them. The toggle is literally the only thing that force-dispatched
--      to the freed driver, which is why "reconnect" was the workaround.
--
-- Fix: extract the online-trigger's dispatch loop into a reusable helper
-- parameterized by driver, and call it ALSO from a new AFTER-UPDATE trigger
-- on `rides` that fires the moment a ride leaves an active status into
-- completed/canceled. Now "finishing a trip" behaves exactly like
-- "reconnecting" for dispatch purposes — no manual toggle needed.
--
-- Server-only change (no app rebuild required). The existing driver client
-- already re-fetches offers via getSearchingRides() when it returns to idle
-- after a trip, so the offers this creates surface immediately.
-- ============================================================

-- 1) Reusable helper: force-dispatch every nearby `searching` ride to ONE
--    driver who just became available. dispatch_ride() -> find_best_drivers()
--    re-checks ALL eligibility (is_online, approved, financially eligible,
--    not on break, no active ride, radius, preferences, fleet), so this only
--    needs the driver's location to scope which searching rides are nearby.
CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_for_driver(p_driver_profile_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r     record;
  v_loc geography;
BEGIN
  SELECT current_location INTO v_loc
  FROM driver_profiles
  WHERE id = p_driver_profile_id;

  IF v_loc IS NULL THEN RETURN; END IF;

  FOR r IN
    SELECT id FROM rides
    WHERE status = 'searching'
      AND pickup_location IS NOT NULL
      AND ST_DWithin(pickup_location, v_loc, 15000)
  LOOP
    PERFORM dispatch_ride(r.id, 10000);
  END LOOP;
END;
$function$;

-- 2) Refactor the driver-online trigger to delegate to the helper (DRY).
--    Behaviour is identical to the live 00269 version (guard on NULL
--    location + EXCEPTION WHEN OTHERS so a dispatch hiccup never breaks the
--    online toggle). Only the loop moved into the helper. The trigger
--    trg_dispatch_on_driver_online is left untouched (only the function body
--    changes via CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_near_driver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- setOnlineStatus updates is_online + current_location together, so
  -- NEW.current_location is normally populated. If not, skip — the 1-min
  -- retry cron will pick the ride up once the location arrives.
  IF NEW.current_location IS NULL THEN RETURN NEW; END IF;

  PERFORM dispatch_searching_rides_for_driver(NEW.id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a dispatch hiccup break the driver's online toggle.
  RETURN NEW;
END;
$function$;

-- 3) New trigger: when a driver's ride ends (completed/canceled), the driver
--    is now free — offer them the rides that were searching while they were
--    busy, exactly as going online does.
CREATE OR REPLACE FUNCTION public.tg_redispatch_searching_on_ride_freed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- NEW.driver_id is driver_profiles.id (see find_best_drivers: r.driver_id =
  -- dp.id). The ride is already completed/canceled at AFTER-trigger time, so
  -- find_best_drivers' "no active ride" gate no longer excludes this driver.
  PERFORM dispatch_searching_rides_for_driver(NEW.driver_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a dispatch hiccup block ride completion / cancellation.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_redispatch_searching_on_ride_freed ON rides;
CREATE TRIGGER trg_redispatch_searching_on_ride_freed
  AFTER UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (
    OLD.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
    AND NEW.status IN ('completed','canceled')
    AND NEW.driver_id IS NOT NULL
  )
  EXECUTE FUNCTION tg_redispatch_searching_on_ride_freed();

COMMENT ON FUNCTION public.dispatch_searching_rides_for_driver(uuid) IS
  'Force-dispatch nearby searching rides to one freshly-available driver. Shared by the is_online trigger and the ride-freed trigger (00388).';
COMMENT ON TRIGGER trg_redispatch_searching_on_ride_freed ON public.rides IS
  '00388: when a ride completes/cancels, re-offer waiting searching rides to the now-free driver (mirrors the online toggle). Fixes "no rides until I reconnect".';
