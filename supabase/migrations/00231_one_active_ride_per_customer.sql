-- BUG-253: defensive layer 1 — DB-level enforcement that a customer
-- can only have a single active ride at any given time. Prevents the
-- "phantom ride" class of bugs where client state desyncs from DB after
-- an address change or interrupted creation.
--
-- Three mechanisms, each redundantly catching the same invariant:
--   1) Partial UNIQUE INDEX — strongest guarantee, kicks in even if
--      triggers are disabled or bypassed by SECURITY DEFINER paths.
--   2) BEFORE INSERT trigger — gives a friendly error message to the
--      client (UNIQUE violation messages are opaque).
--   3) cleanup_orphan_searching_rides() cron — catches rides stuck in
--      'searching' with no live offers (e.g. dispatch_ride exhausted
--      retries but failed to cancel). Runs every minute.

-- 1. Partial unique index on active states
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_per_customer
  ON public.rides (customer_id)
  WHERE status IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  );

COMMENT ON INDEX public.rides_one_active_per_customer
  IS 'BUG-253: enforces 1 active ride per customer at the storage layer.';

-- 2. BEFORE INSERT trigger with a friendly error message
CREATE OR REPLACE FUNCTION public.enforce_one_active_ride_per_customer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.rides
      WHERE customer_id = NEW.customer_id
        AND status IN (
          'searching','accepted','driver_en_route',
          'arrived_at_pickup','in_progress','arrived_at_destination'
        )
        AND (TG_OP = 'INSERT' OR id <> NEW.id)
    ) THEN
      RAISE EXCEPTION 'customer_has_active_ride'
        USING ERRCODE = 'P0001',
              HINT = 'Cancel the existing active ride before creating a new one';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_one_active_ride_per_customer ON public.rides;
CREATE TRIGGER trg_enforce_one_active_ride_per_customer
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.enforce_one_active_ride_per_customer();

-- 3. Cron cleanup for orphan 'searching' rides (no live offers, > 5 min old)
CREATE OR REPLACE FUNCTION public.cleanup_orphan_searching_rides()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH stale AS (
    SELECT r.id FROM public.rides r
    WHERE r.status = 'searching'
      AND r.created_at < now() - interval '5 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers o
        WHERE o.ride_id = r.id
          AND o.status = 'pending'
          AND o.expires_at > now()
      )
  )
  UPDATE public.rides
  SET status = 'canceled',
      cancellation_reason = 'auto_canceled_no_drivers_after_5min',
      canceled_at = now()
  WHERE id IN (SELECT id FROM stale);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_orphan_searching_rides() TO service_role;
COMMENT ON FUNCTION public.cleanup_orphan_searching_rides()
  IS 'BUG-253: auto-cancels rides stuck in searching for >5min with no live offers.';

-- Schedule via pg_cron (idempotent — unschedule first if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup_orphan_searching_rides') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'cleanup_orphan_searching_rides'
    );
    PERFORM cron.schedule(
      'cleanup_orphan_searching_rides',
      '* * * * *',
      $job$SELECT public.cleanup_orphan_searching_rides();$job$
    );
  END IF;
END $$;
