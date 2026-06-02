-- 00368 — Rate-limit ride creation (F1, launch-readiness round 2).
--
-- Gap found in the audit: there is NO throttle on ride creation. The
-- rides_one_active_per_customer partial unique index only caps CONCURRENT
-- rides — it does not stop sequential spam (create → cancel → create → ...),
-- which could flood the dispatcher / push fan-out.
--
-- Fix: a BEFORE INSERT trigger that calls the existing check_rate_limit RPC.
-- It only fires for REAL customer-initiated inserts (auth.uid() = customer_id),
-- so it never throttles inserts made by cron jobs / service_role (recurring &
-- scheduled rides, which run without an end-user auth context).
--
-- Limit: 6 ride-creation attempts per 60s per customer. Legit riders never hit
-- this; abusers do. Tunable here if needed.

CREATE OR REPLACE FUNCTION public.tg_rides_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_allowed boolean;
BEGIN
  -- Only throttle inserts initiated by the ride's own customer. Cron /
  -- service_role inserts (recurring/scheduled rides) have auth.uid() = NULL
  -- (or a different uid) and pass through untouched.
  IF v_uid IS NULL OR v_uid IS DISTINCT FROM NEW.customer_id THEN
    RETURN NEW;
  END IF;

  SELECT allowed INTO v_allowed
  FROM check_rate_limit('ride_create:' || NEW.customer_id::text, 6, 60);

  -- Defensive: if the limiter can't answer (NULL), allow — never block ride
  -- creation because of a limiter hiccup.
  IF v_allowed IS FALSE THEN
    RAISE EXCEPTION 'ride_rate_limited'
      USING HINT = 'Too many ride requests in a short window. Wait a moment and try again.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_rate_limit ON public.rides;
CREATE TRIGGER trg_rides_rate_limit
  BEFORE INSERT ON public.rides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_rides_rate_limit();

COMMENT ON FUNCTION public.tg_rides_rate_limit() IS
  '00368 F1 — throttles customer-initiated ride creation to 6/60s via check_rate_limit. Skips cron/service_role inserts (auth.uid() <> customer_id).';
