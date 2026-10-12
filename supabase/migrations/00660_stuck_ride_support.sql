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

-- 4. When the GPS trail shows the driver leaving the pickup: the first point more
--    than 100 m from it at or after p_since. Per point, the earlier of the phone's
--    time and the server's receipt: a later departure means more wait for the
--    rider, so it is never later than the server saw the point (00659 uses the
--    later one for arrival, for the same reason). Only the ride's driver's points.
CREATE OR REPLACE FUNCTION public._ride_gps_departure_at(p_ride_id uuid, p_since timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT CASE WHEN s.m IS NULL THEN NULL ELSE LEAST(s.m, now()) END
  FROM (
    SELECT min(LEAST(le.recorded_at, le.received_at)) AS m
    FROM public.ride_location_events le
    JOIN public.rides r ON r.id = le.ride_id
    WHERE le.ride_id = p_ride_id
      AND p_since IS NOT NULL
      AND le.driver_id = r.driver_id
      AND LEAST(le.recorded_at, le.received_at) >= p_since
      AND ST_Distance(le.location, r.pickup_location) > 100
  ) s;
$function$;
REVOKE ALL ON FUNCTION public._ride_gps_departure_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- 5. What completing the ride would charge, for a given pickup time. NULL when the
--    ride has no estimate snapshot (none in the last 90 days). Same formula as
--    complete_ride_and_pay's strict-parity path. A corporate ride whose commission
--    is below the default ends lower; is_corporate tells the panel.
CREATE OR REPLACE FUNCTION public._active_ride_charge_preview(p_ride public.rides, p_pickup_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total integer;
  v_w record;
BEGIN
  SELECT s.total INTO v_total FROM public.ride_pricing_snapshots s
   WHERE s.ride_id = p_ride.id AND s.snapshot_type = 'estimate' LIMIT 1;
  IF v_total IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_w FROM public._wait_charge_for(p_ride.service_type, p_ride.driver_arrived_at, p_pickup_at);
  RETURN jsonb_build_object(
    'agreed_cup', v_total,
    'discount_cup', COALESCE(p_ride.discount_amount_cup, 0),
    'wait_minutes', v_w.wait_minutes,
    'billable_minutes', v_w.billable_minutes,
    'wait_cup', v_w.charge,
    'insurance_cup', CASE WHEN p_ride.insurance_selected AND p_ride.insurance_premium_cup > 0
                          THEN p_ride.insurance_premium_cup ELSE 0 END,
    'is_corporate', p_ride.corporate_account_id IS NOT NULL,
    'total_cup', GREATEST(v_total - COALESCE(p_ride.discount_amount_cup, 0), 0) + v_w.charge);
END;
$function$;
REVOKE ALL ON FUNCTION public._active_ride_charge_preview(public.rides, timestamptz) FROM PUBLIC, anon, authenticated;

-- 6. A support push. In a block of its own, like 00628's: a failing push never
--    takes back the action; it leaves a WARNING and an rpc_attempt_log row.
CREATE OR REPLACE FUNCTION public._support_ride_push(p_rpc text, p_ride_id uuid, p_user_id uuid,
  p_title text, p_body text, p_category text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING '%: no service role key, no push for ride %', p_rpc, p_ride_id;
      PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_ride_id, 'push_failed',
        jsonb_build_object('user_id', p_user_id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('support-ride-resolved',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object('user_id', p_user_id::text, 'title', p_title, 'body', p_body,
                                      'category', p_category,
                                      'data', COALESCE(p_data, '{}'::jsonb) || jsonb_build_object('ride_id', p_ride_id::text)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '%: the push for ride % failed: % %', p_rpc, p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt(p_rpc, auth.uid(), p_ride_id, 'push_failed',
      jsonb_build_object('user_id', p_user_id, 'error', SQLERRM));
  END;
END;
$function$;
REVOKE ALL ON FUNCTION public._support_ride_push(text, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- 7. Everything the active view shows, in one call.
CREATE OR REPLACE FUNCTION public.admin_active_ride_context(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_actions text[];
  v_dep timestamptz;
  v_start timestamptz;
  v_source text;
  v_preview jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  v_actions := CASE v_ride.status
    WHEN 'accepted' THEN ARRAY['release', 'advance']
    WHEN 'driver_en_route' THEN ARRAY['release', 'advance']
    WHEN 'arrived_at_pickup' THEN ARRAY['advance']
    WHEN 'in_progress' THEN ARRAY['advance', 'complete']
    WHEN 'arrived_at_destination' THEN ARRAY['complete']
    ELSE ARRAY[]::text[] END;

  IF v_ride.status = 'arrived_at_pickup' THEN
    v_dep := public._ride_gps_departure_at(v_ride.id, v_ride.driver_arrived_at);
    v_start := COALESCE(v_ride.pickup_at, v_dep, v_ride.driver_arrived_at, now());
    v_source := CASE WHEN v_ride.pickup_at IS NOT NULL THEN 'recorded'
                     WHEN v_dep IS NOT NULL THEN 'gps'
                     WHEN v_ride.driver_arrived_at IS NOT NULL THEN 'arrival'
                     ELSE 'now' END;
    v_preview := public._active_ride_charge_preview(v_ride, v_start);
  ELSIF v_ride.status IN ('in_progress', 'arrived_at_destination') THEN
    v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  ELSE
    v_preview := public._active_ride_charge_preview(v_ride, NULL);
  END IF;

  RETURN jsonb_build_object(
    'ride', (SELECT jsonb_build_object(
        'id', v_ride.id, 'code', public._ride_short_code(v_ride.id), 'status', v_ride.status,
        'service_type', v_ride.service_type, 'payment_method', v_ride.payment_method,
        'is_corporate', v_ride.corporate_account_id IS NOT NULL,
        'pickup_address', v_ride.pickup_address, 'dropoff_address', v_ride.dropoff_address,
        'created_at', v_ride.created_at, 'accepted_at', v_ride.accepted_at,
        'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at,
        'scheduled_at', v_ride.scheduled_at, 'estimated_fare_cup', v_ride.estimated_fare_cup,
        'customer_id', v_ride.customer_id, 'customer_name', c.full_name,
        'customer_phone', c.phone, 'customer_is_test', c.is_test)
      FROM public.users c WHERE c.id = v_ride.customer_id),
    'driver', (SELECT jsonb_build_object(
        'driver_profile_id', dp.id, 'full_name', u.full_name, 'phone', u.phone,
        'is_online', dp.is_online, 'last_heartbeat_at', dp.last_heartbeat_at,
        'vehicle_label', (SELECT concat_ws(' · ',
             NULLIF(concat_ws(' ', NULLIF(btrim(v.make), ''), NULLIF(btrim(v.model), '')), ''),
             NULLIF(btrim(v.color), ''), NULLIF(btrim(v.plate_number), ''))
           FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active LIMIT 1))
      FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.id = v_ride.driver_id),
    'last_point', (SELECT jsonb_build_object(
        'recorded_at', le.recorded_at, 'received_at', le.received_at,
        'distance_to_pickup_m', round(ST_Distance(le.location, v_ride.pickup_location))::int,
        'distance_to_dropoff_m', round(ST_Distance(le.location, v_ride.dropoff_location))::int)
      FROM public.ride_location_events le WHERE le.ride_id = v_ride.id
      ORDER BY le.recorded_at DESC, le.id DESC LIMIT 1),
    'alert', (SELECT jsonb_build_object('reason', a.reason, 'detected_at', a.detected_at)
      FROM public.stuck_ride_alerts a WHERE a.ride_id = v_ride.id AND a.resolved_at IS NULL),
    'preview', v_preview,
    'start_pickup_at', CASE WHEN v_ride.status = 'arrived_at_pickup' THEN v_start END,
    'start_pickup_source', v_source,
    'allowed_actions', to_jsonb(v_actions));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_active_ride_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_active_ride_context(uuid) TO authenticated, service_role;
