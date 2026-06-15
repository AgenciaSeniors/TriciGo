-- 00435_round7_fleet_sched_hardening.sql
-- ============================================================================
-- Pre-launch audit round 7 — follow-up batch (DB-only): FLEET-01 (P2) + the
-- DB-only scheduled/recurring P3s (SCHED-01, SCHED-03). The P0/P2 INSERT-protect
-- class shipped in 00434; this closes the remaining server-side items that do not
-- need an app rebuild. (Deferred to the v6 rebuild: PUSH-01, SCHED-05. Deferred as
-- low-value/needs-care: KYC-02/03, FLEET-04, RCHG-02.)
--
-- FLEET-01 (P2): fleet_members had NO trigger and its owner INSERT policy does not
-- restrict status/driver_id, so a fleet owner could INSERT status='active' with a
-- forced driver_id=<any real driver> — claiming arbitrary drivers into their fleet
-- with no consent and skipping admin review. (Inert today behind the 00434 FLEET-02
-- fix: an attacker can no longer get an approved corp, so corporate dispatch
-- restriction is moot — but we close the membership-forgery vector.) Fix: a protect
-- trigger that forces owner INSERTs to status='pending_review' / driver_id=NULL and
-- forbids non-trusted UPDATEs from self-promoting status or setting driver_id. The
-- two legitimate writers that DO set driver_id + 'active' — auto_link_fleet_member_
-- on_signup (signup trigger) and relink_fleet_member_for_existing_driver (admin RPC)
-- — are whitelisted via the app.trusted_fleet_update flag (relink is admin anyway).
--
-- SCHED-03 (P3): a scheduled ride booked with scheduled_at <= now() is dispatched
-- TWICE — once by on_ride_insert_dispatch at INSERT, and again by the
-- activate_scheduled_rides cron (its scheduled_notified=false window still matches).
-- Fix: when on_ride_insert_dispatch dispatches a past-due scheduled ride, mark
-- scheduled_notified=true so the cron skips it.
--
-- SCHED-01 (P3): create_rides_for_recurring loops over recurring rules with no
-- per-iteration error handling, so a single failing rule (e.g. the customer already
-- has an active ride → enforce_one_active_ride_per_customer raises) aborts the
-- whole cron batch and no other customer's recurring rides spawn. Fix: wrap each
-- iteration in BEGIN/EXCEPTION (implicit savepoint) so one failure is logged and
-- skipped without rolling back the batch.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- FLEET-01: protect trigger on fleet_members.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    -- Owner adds a prospective member: always pending_review, never pre-linked to a
    -- driver_id and never auto-active. (driver_name / driver_phone / contact / license
    -- stay as submitted; the auto-link-on-signup trigger and the admin relink RPC set
    -- driver_id + 'active' under the trusted-flag / admin path.)
    NEW.status          := 'pending_review';
    NEW.driver_id       := NULL;
    NEW.signed_up_at    := NULL;
    NEW.reviewed_at     := NULL;
    NEW.reviewed_by     := NULL;
    NEW.rejected_reason := NULL;
    RETURN NEW;
  ELSE
    -- Non-trusted UPDATE by the owner: cannot self-promote status or assert a driver_id.
    NEW.status       := OLD.status;
    NEW.driver_id    := OLD.driver_id;
    NEW.signed_up_at := OLD.signed_up_at;
    NEW.reviewed_at  := OLD.reviewed_at;
    NEW.reviewed_by  := OLD.reviewed_by;
    RETURN NEW;
  END IF;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fleet_members_protect ON public.fleet_members;
CREATE TRIGGER trg_fleet_members_protect
  BEFORE INSERT OR UPDATE ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_protect();

-- Whitelist the signup auto-link path (sets driver_id + status='active'): it runs in
-- the signing-up user's context (not admin / not the fleet owner), so it must mark
-- the trusted flag for the new protect trigger. Body otherwise verbatim.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member_id uuid;
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  -- FLEET-01: trusted writer (links a real driver to a previously approved member).
  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE driver_phone = NEW.phone
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
  RETURNING id INTO v_member_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.relink_fleet_member_for_existing_driver(p_driver_id uuid, p_phone text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: only admins can relink fleet members';
  END IF;

  -- FLEET-01: admin already bypasses the protect trigger, but set the flag for clarity.
  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = p_driver_id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE driver_phone = p_phone
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCHED-03: avoid double-dispatch of a past-due scheduled ride.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.on_ride_insert_dispatch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status = 'searching'
     AND (NEW.is_scheduled IS NOT TRUE
          OR NEW.scheduled_at IS NULL
          OR NEW.scheduled_at <= now()) THEN
    -- SCHED-03: if a scheduled ride is already past-due at insert, dispatch it now AND
    -- mark it notified so activate_scheduled_rides (whose window still matches) does
    -- not dispatch it a second time.
    IF NEW.is_scheduled IS TRUE AND NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at <= now() THEN
      UPDATE rides SET scheduled_notified = true WHERE id = NEW.id;
    END IF;
    PERFORM dispatch_ride(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- SCHED-01: per-iteration error isolation in the recurring-ride cron.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_rides_for_recurring()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_next TIMESTAMPTZ;
  v_pickup GEOGRAPHY;
  v_dropoff GEOGRAPHY;
BEGIN
  FOR v_rec IN
    SELECT * FROM recurring_rides
    WHERE status = 'active'
      AND next_occurrence_at IS NOT NULL
      AND next_occurrence_at <= NOW() + interval '24 hours'
      AND (last_triggered_at IS NULL
           OR last_triggered_at < next_occurrence_at - interval '25 hours')
  LOOP
    -- SCHED-01: isolate each rule so one failure (e.g. the customer already has an
    -- active ride → enforce_one_active_ride_per_customer) does not abort the batch.
    BEGIN
      v_pickup  := ST_SetSRID(ST_MakePoint(v_rec.pickup_longitude::float8,  v_rec.pickup_latitude::float8),  4326)::geography;
      v_dropoff := ST_SetSRID(ST_MakePoint(v_rec.dropoff_longitude::float8, v_rec.dropoff_latitude::float8), 4326)::geography;

      INSERT INTO rides (
        customer_id, service_type, payment_method,
        pickup_location, pickup_address, pickup_lat, pickup_lng,
        dropoff_location, dropoff_address, dropoff_lat, dropoff_lng,
        estimated_fare_cup, estimated_distance_m, estimated_duration_s,
        is_scheduled, scheduled_at, status
      ) VALUES (
        v_rec.customer_id, v_rec.service_type, v_rec.payment_method::payment_method,
        v_pickup, v_rec.pickup_address, v_rec.pickup_latitude::float8, v_rec.pickup_longitude::float8,
        v_dropoff, v_rec.dropoff_address, v_rec.dropoff_latitude::float8, v_rec.dropoff_longitude::float8,
        0, 0, 0, true, v_rec.next_occurrence_at, 'searching'
      );

      v_next := compute_next_occurrence(
        v_rec.days_of_week::smallint[],
        v_rec.time_of_day,
        'America/Havana'::text,
        v_rec.next_occurrence_at + interval '1 hour'
      );

      UPDATE recurring_rides
        SET last_triggered_at = NOW(),
            next_occurrence_at = v_next,
            updated_at = NOW()
      WHERE id = v_rec.id;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'create_rides_for_recurring: skipped recurring % : % %', v_rec.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$function$;
