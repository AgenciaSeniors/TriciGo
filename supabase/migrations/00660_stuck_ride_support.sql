-- 00660: support helps a ride that already has a driver (design:
-- docs/superpowers/specs/2026-10-12-stuck-ride-support-design.md).
--
-- Today the panel can only cancel an accepted ride. Measured on 2026-10-12: the
-- automatic release returns a ride to search after 12 minutes of driver silence
-- but only before pickup; after pickup it only raises a stuck_ride_alerts row;
-- a driver without GPS cannot mark arrival (gps_required). Support had no tool.
--
-- What this adds (all for admin and super_admin; marketing is refused):
--   admin_active_ride_context   what the assist page shows for an active ride
--   admin_release_active_ride   back to search now (accepted, driver_en_route)
--   admin_advance_active_ride   one step: arrived / started / at destination
--   admin_complete_active_ride  complete and charge (agreed price + recorded wait)
-- Each one locks the ride, refuses when the status is not the one support saw
-- (ride_changed), needs a reason, logs to admin_actions and pushes through
-- cron_http_post ('support-ride-resolved').
--
-- calculate_wait_charge now calls _wait_charge_for, a pure function with the
-- same rules, so the panel can preview the charge the completion will make.
-- It is replaced only when the live body is the one this migration was written
-- for (md5 2c0679d1...). The rehearsal checks the two bodies give the same
-- answers on 168 waits, and the prod check on every ride with both times.

SET lock_timeout = '5s';

-- 1. Support marks arrival from 'accepted' in one step: one status push and one
--    SMS for the rider instead of two. Drivers keep the step-by-step path.
INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles)
VALUES ('accepted', 'arrived_at_pickup', ARRAY['admin', 'super_admin']::public.user_role[])
ON CONFLICT (from_status, to_status) DO NOTHING;

-- 2. The wait charge as a pure function: calculate_wait_charge's rules, no writes.
CREATE OR REPLACE FUNCTION public._wait_charge_for(
  p_service_type text, p_arrived_at timestamptz, p_pickup_at timestamptz,
  OUT wait_minutes integer, OUT billable_minutes integer, OUT charge integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
  v_wait_seconds numeric;
  v_max_billable integer;
  v_band_rate integer;
  v_at_t time;
  v_at_dow int;
BEGIN
  IF p_arrived_at IS NULL OR p_pickup_at IS NULL THEN
    wait_minutes := 0; billable_minutes := 0; charge := 0;
    RETURN;
  END IF;
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type;
  v_wait_seconds := EXTRACT(EPOCH FROM (p_pickup_at - p_arrived_at));
  wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::integer);
  billable_minutes := GREATEST(0, wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
  v_max_billable := GREATEST(0, public.get_platform_config_numeric('max_billable_wait_minutes', 20)::integer);
  billable_minutes := LEAST(billable_minutes, v_max_billable);

  -- 00502: the rate of the band the wait STARTED in (Havana time).
  BEGIN
    v_at_t   := (p_arrived_at AT TIME ZONE 'America/Havana')::time;
    v_at_dow := EXTRACT(dow FROM (p_arrived_at AT TIME ZONE 'America/Havana'))::int;
    SELECT pr.per_wait_minute_rate_cup INTO v_band_rate
    FROM public.pricing_rules pr
    WHERE pr.service_type = p_service_type
      AND pr.is_active = true
      AND pr.per_wait_minute_rate_cup IS NOT NULL
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_at_t >= pr.time_window_start AND v_at_t < pr.time_window_end
                ELSE v_at_t >= pr.time_window_start OR v_at_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_at_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_band_rate := NULL;
  END;

  charge := billable_minutes * COALESCE(v_band_rate, v_svc.per_wait_minute_rate_cup, 0);
END;
$function$;
REVOKE ALL ON FUNCTION public._wait_charge_for(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;

-- 3. calculate_wait_charge keeps its signature, its writes and its answers.
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.calculate_wait_charge(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2c0679d1ce8600da188e4ff101ddd2ca' AND v_md5 IS DISTINCT FROM 'dcf518cffa45073e26fbd84833776bc5' THEN
    RAISE EXCEPTION '00660: calculate_wait_charge is not the body this migration replaces (md5 %)', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride rides%ROWTYPE;
  v_w record;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  -- 00660: the rules live in _wait_charge_for, which the support preview also uses.
  SELECT * INTO v_w FROM _wait_charge_for(v_ride.service_type, v_ride.driver_arrived_at, v_ride.pickup_at);
  UPDATE rides SET wait_time_minutes = v_w.wait_minutes, wait_time_charge_cup = v_w.charge WHERE id = p_ride_id;
  SELECT v_w.wait_minutes AS wait_minutes, v_w.billable_minutes AS billable_minutes, v_w.charge AS charge INTO result;
  RETURN result;
END;
$function$;
