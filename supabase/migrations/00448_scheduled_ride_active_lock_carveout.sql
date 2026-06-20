-- 00448_scheduled_ride_active_lock_carveout.sql
-- Pre-launch audit 2026-06-20 — AUD-008 (P2, ride flow). 0 scheduled rides in prod → latent.
--
-- The one-active-ride-per-customer lock (00231) — a partial UNIQUE index + a BEFORE INSERT/UPDATE
-- trigger — counts status='searching' as active with NO carve-out for scheduled/recurring rides.
-- But 00407 deliberately keeps scheduled & recurring rides in 'searching' from creation (with
-- scheduled_at as the abandonment clock), and activate_scheduled_rides flips scheduled_notified=true
-- only when it dispatches them. So a PENDING future scheduled ride (is_scheduled=true,
-- scheduled_notified=false) wrongly counts as "active": (1) it blocks an immediate booking with
-- 'customer_has_active_ride'; (2) a recurring occurrence is silently dropped; (3) two future
-- scheduled rides collide on the unique index.
--
-- Fix: exclude PENDING (un-notified) scheduled rides from the active set in BOTH the trigger and the
-- index. Once activate_scheduled_rides flips scheduled_notified=true (just before dispatch), the ride
-- counts normally — so a customer still can't have two simultaneously dispatched rides.

-- ── Trigger: reproduced from the live body (00231) + the pending-scheduled carve-out ──
CREATE OR REPLACE FUNCTION public.enforce_one_active_ride_per_customer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  )
  AND NOT (COALESCE(NEW.is_scheduled, false) AND NOT COALESCE(NEW.scheduled_notified, false)) THEN
    IF EXISTS (
      SELECT 1 FROM public.rides
      WHERE customer_id = NEW.customer_id
        AND status IN (
          'searching','accepted','driver_en_route',
          'arrived_at_pickup','in_progress','arrived_at_destination'
        )
        AND NOT (COALESCE(is_scheduled, false) AND NOT COALESCE(scheduled_notified, false))
        AND (TG_OP = 'INSERT' OR id <> NEW.id)
    ) THEN
      RAISE EXCEPTION 'customer_has_active_ride'
        USING ERRCODE = 'P0001',
              HINT = 'Cancel the existing active ride before creating a new one';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── Partial UNIQUE index: same active statuses, excluding pending scheduled rides. ──
-- (now() is not immutable so the predicate uses scheduled_notified, which dispatch flips.)
DROP INDEX IF EXISTS public.rides_one_active_per_customer;
CREATE UNIQUE INDEX rides_one_active_per_customer
  ON public.rides (customer_id)
  WHERE status = ANY (ARRAY[
          'searching'::ride_status, 'accepted'::ride_status, 'driver_en_route'::ride_status,
          'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status])
    AND NOT (COALESCE(is_scheduled, false) AND NOT COALESCE(scheduled_notified, false));
