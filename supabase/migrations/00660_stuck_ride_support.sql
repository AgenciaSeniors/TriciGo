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
-- Each action locks the ride, refuses when the status or the driver is not the
-- one support saw (ride_changed) and when the admin is the ride's rider or
-- driver (self_ride), needs a reason, logs to admin_actions and pushes through
-- cron_http_post ('support-ride-resolved').
--
-- Both releases, support's and the automatic one (release_rides_from_dead_drivers
-- block A, patched in place from its live body md5 c99dd7b8...), now give the
-- ride back to the drivers it had been offered to, and reset the previous
-- driver's GPS and proximity state.
--
-- calculate_wait_charge now calls _wait_charge_for, a pure function with the
-- same rules, so the panel can preview the charge the completion will make.
-- It is replaced only when the live body is the one this migration was written
-- for (md5 2c0679d1...). The rehearsal checks the two bodies give the same
-- answers on 192 waits, and the prod check on every ride with both times.

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
 STABLE
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

-- 4. When the GPS trail shows the driver leaving the pickup. Only the ride's
--    current driver's points at or after p_since count, each at the earlier of
--    the phone's time and the server's receipt: a later departure means more
--    wait for the rider, so it is never later than the server saw the point
--    (00659 uses the later one for arrival, for the same reason).
--    f = the first point more than 100 m from the pickup; p = the last point
--    before it, or p_since when there is none. When more than 6 minutes pass
--    between p and f the app was not running, and the departure is p: the last
--    moment the trail proves the driver was still there. Otherwise it is f.
--    Never later than now(); NULL with no far point or no p_since.
CREATE OR REPLACE FUNCTION public._ride_gps_departure_at(p_ride_id uuid, p_since timestamptz)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  -- Measured in prod on 2026-10-12: a live app sends a point every few seconds
  -- while the driver waits, and the longest gap seen was 5.5 minutes. A silence
  -- longer than 6 minutes is treated as the app not running, and the wait it did
  -- not record is not charged.
  c_max_gap constant interval := interval '6 minutes';
  v_far timestamptz;
  v_last timestamptz;
BEGIN
  IF p_since IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT min(LEAST(le.recorded_at, le.received_at)) INTO v_far
  FROM public.ride_location_events le
  JOIN public.rides r ON r.id = le.ride_id
  WHERE le.ride_id = p_ride_id
    AND le.driver_id = r.driver_id
    AND LEAST(le.recorded_at, le.received_at) >= p_since
    AND ST_Distance(le.location, r.pickup_location) > 100;
  IF v_far IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT max(LEAST(le.recorded_at, le.received_at)) INTO v_last
  FROM public.ride_location_events le
  JOIN public.rides r ON r.id = le.ride_id
  WHERE le.ride_id = p_ride_id
    AND le.driver_id = r.driver_id
    AND LEAST(le.recorded_at, le.received_at) >= p_since
    AND LEAST(le.recorded_at, le.received_at) < v_far;
  v_last := COALESCE(v_last, p_since);
  IF v_far - v_last > c_max_gap THEN
    RETURN LEAST(v_last, now());
  END IF;
  RETURN LEAST(v_far, now());
END;
$function$;
REVOKE ALL ON FUNCTION public._ride_gps_departure_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- 5. What completing the ride would charge, for a given pickup time. NULL when the
--    ride has no estimate snapshot (none in the last 90 days). Same formula as
--    complete_ride_and_pay's strict-parity path. A corporate ride whose commission
--    is below the default ends lower; is_corporate tells the panel.
CREATE OR REPLACE FUNCTION public._active_ride_charge_preview(p_ride public.rides, p_pickup_at timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
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

-- 7. A released ride goes back to the drivers it was offered to. accept_ride_v2
--    marks every other pending offer 'superseded', and dispatch_ride re-arms an
--    existing row only when it is 'expired' and its expires_at is past
--    reoffer_cooldown_s. Without this, nobody offered the ride before it was
--    taken ever gets it again. 'rejected' stays: that driver said no. The
--    released driver's own rows stay too: his 'accepted' row keeps the ride away
--    from him. Returns how many offers were reopened.
CREATE OR REPLACE FUNCTION public._reopen_ride_offers(p_ride_id uuid, p_released_driver uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.ride_offers
     SET status = 'expired',
         expires_at = now() - make_interval(secs => GREATEST(0, public.get_platform_config_numeric('reoffer_cooldown_s', 120))::int + 1)
   WHERE ride_id = p_ride_id
     AND driver_profile_id IS DISTINCT FROM p_released_driver
     AND status IN ('superseded', 'expired');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public._reopen_ride_offers(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 8. The automatic release (release_rides_from_dead_drivers, block A) gets the
--    same two things as the support release: the previous driver's GPS and
--    proximity state is reset, and the other drivers' offers are reopened.
--    Patched in place from the live body (md5 c99dd7b8...), refused on any other.
DO $patch$
DECLARE
  c_fn constant regprocedure := 'public.release_rides_from_dead_drivers()'::regprocedure;
  c_old_md5 constant text := 'c99dd7b82a9cddaa2bf21a48d9bff7f7';
  c_new_md5 constant text := 'cdfaba6fef339647c23c7fcb0a6de317';
  c_upd_old constant text := E'        last_dispatched_at = NULL,\n';
  c_upd_new constant text := E'        last_dispatched_at = NULL,\n'
                          || E'        -- 00660: the previous driver''s GPS and proximity state goes with him,\n'
                          || E'        -- as in admin_release_active_ride.\n'
                          || E'        driver_gps_status = ''healthy'',\n'
                          || E'        driver_gps_unavailable_at = NULL,\n'
                          || E'        gps_override_requested_at = NULL,\n'
                          || E'        gps_override_confirmed_at = NULL,\n'
                          || E'        gps_check_distance_m = NULL,\n'
                          || E'        driver_custom_rate_cup = NULL,\n'
                          || E'        proximity_pickup_notified_at = NULL,\n';
  c_off_old constant text := E'WHERE ride_id = r.id AND driver_profile_id = r.driver_id AND status = ''pending'';\n';
  c_off_new constant text := E'WHERE ride_id = r.id AND driver_profile_id = r.driver_id AND status = ''pending'';\n'
                          || E'\n'
                          || E'      -- 00660: the drivers offered the ride before he took it get it again.\n'
                          || E'      PERFORM public._reopen_ride_offers(r.id, r.driver_id);\n';
  v_src text;
  v_md5 text;
  v_def text;
BEGIN
  SELECT prosrc, md5(prosrc) INTO v_src, v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM c_old_md5 THEN
    RAISE EXCEPTION '00660: release_rides_from_dead_drivers is not the body this migration patches (md5 %)', v_md5;
  END IF;
  IF (length(v_src) - length(replace(v_src, c_upd_old, ''))) / length(c_upd_old) <> 1
     OR (length(v_src) - length(replace(v_src, c_off_old, ''))) / length(c_off_old) <> 1 THEN
    RAISE EXCEPTION '00660: release_rides_from_dead_drivers does not contain each patched text exactly once';
  END IF;
  v_def := pg_get_functiondef(c_fn);
  EXECUTE replace(replace(v_def, c_upd_old, c_upd_new), c_off_old, c_off_new);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 IS DISTINCT FROM c_new_md5 THEN
    RAISE EXCEPTION '00660: release_rides_from_dead_drivers patched to an unexpected body (md5 %)', v_md5;
  END IF;
END
$patch$;

-- 9. Everything the active view shows, in one call.
CREATE OR REPLACE FUNCTION public.admin_active_ride_context(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_actions text[];
  v_dep timestamptz;
  v_start timestamptz;
  v_source text;
  v_preview jsonb;
  v_proof_missing boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF auth.uid() = v_ride.customer_id OR auth.uid() = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;

  v_actions := CASE v_ride.status
    WHEN 'accepted' THEN ARRAY['release', 'advance']
    WHEN 'driver_en_route' THEN ARRAY['release', 'advance']
    WHEN 'arrived_at_pickup' THEN ARRAY['advance']
    WHEN 'in_progress' THEN ARRAY['advance', 'complete']
    WHEN 'arrived_at_destination' THEN ARRAY['complete']
    ELSE ARRAY[]::text[] END;
  -- Only what the RPCs accept: a ride scheduled for later is neither released
  -- nor advanced (support cancels it from the ride page).
  IF v_ride.status IN ('accepted', 'driver_en_route') AND v_ride.scheduled_at > now() THEN
    v_actions := array_remove(array_remove(v_actions, 'release'), 'advance');
  END IF;
  -- A cargo ride is completed only with the recipient's code and the delivery
  -- photo (admin_complete_active_ride refuses otherwise). Advancing it to the
  -- destination stays, so the driver's app can collect them.
  v_proof_missing := COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
    SELECT 1 FROM public.delivery_details dd
    WHERE dd.ride_id = v_ride.id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL);
  IF v_proof_missing THEN
    v_actions := array_remove(v_actions, 'complete');
  END IF;

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
      FROM public.ride_location_events le
      WHERE le.ride_id = v_ride.id AND le.driver_id = v_ride.driver_id
      ORDER BY GREATEST(le.recorded_at, le.received_at) DESC, le.recorded_at DESC, le.id DESC LIMIT 1),
    'alert', (SELECT jsonb_build_object('reason', a.reason, 'detected_at', a.detected_at)
      FROM public.stuck_ride_alerts a WHERE a.ride_id = v_ride.id AND a.resolved_at IS NULL),
    'driver_profile_id', v_ride.driver_id,
    'delivery_proof_missing', v_proof_missing,
    'preview', v_preview,
    'start_pickup_at', CASE WHEN v_ride.status = 'arrived_at_pickup' THEN v_start END,
    'start_pickup_source', v_source,
    'allowed_actions', to_jsonb(v_actions));
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_active_ride_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_active_ride_context(uuid) TO authenticated, service_role;

-- 10. Back to search, now (accepted, driver_en_route). What release_rides_from_dead_drivers
--     block A does (with section 8: the previous driver's GPS and proximity
--     state is reset, so a rider confirmation given to him does not let the
--     next driver skip the arrival gate, and the other drivers' offers are
--     reopened), plus: the 00628 wait alert is stamped (support is already on
--     it), and dispatch runs at once. When that dispatch is round 2 or 3, the
--     rider also gets its "Seguimos buscando" push, as after the automatic
--     release.
CREATE OR REPLACE FUNCTION public.admin_release_active_ride(p_ride_id uuid, p_expected_status text,
  p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_reopened integer;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The driver first, then the ride: the order of release_rides_from_dead_drivers
  -- (block A) and update_driver_position, so a release never deadlocks with them.
  PERFORM 1 FROM public.driver_profiles WHERE id = p_expected_driver_id FOR UPDATE;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('accepted', 'driver_en_route') THEN
    RETURN jsonb_build_object('error', 'ride_not_releasable', 'status', v_ride.status);
  END IF;
  IF v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  -- He reconnects by hand (the push tells him). No auto_offline_at: the
  -- trigger tg_driver_profiles_shift_intent clears it on any is_online change a
  -- person makes, an admin included.
  UPDATE public.driver_profiles SET is_online = false WHERE id = v_ride.driver_id AND is_online;

  UPDATE public.rides SET
    status = 'searching', driver_id = NULL, accepted_at = NULL,
    searching_seen_at = now(), last_dispatched_at = NULL,
    driver_gps_status = 'healthy', driver_gps_unavailable_at = NULL,
    gps_override_requested_at = NULL, gps_override_confirmed_at = NULL,
    gps_check_distance_m = NULL, driver_custom_rate_cup = NULL,
    proximity_pickup_notified_at = NULL,
    updated_at = now()
  WHERE id = p_ride_id;

  -- The driver's accepted offer stays 'accepted': dispatch never re-offers it,
  -- and the driver's acceptance_rate does not move.
  UPDATE public.ride_offers SET status = 'expired'
   WHERE ride_id = p_ride_id AND driver_profile_id = v_ride.driver_id AND status = 'pending';
  v_reopened := public._reopen_ride_offers(p_ride_id, v_ride.driver_id);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.ride_assist AS ra (ride_id, wait_alert_sent_at, wait_email_sent_at)
  VALUES (p_ride_id, now(), now())
  ON CONFLICT (ride_id) DO UPDATE SET
    wait_alert_sent_at = COALESCE(ra.wait_alert_sent_at, now()),
    wait_email_sent_at = COALESCE(ra.wait_email_sent_at, now());

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_release_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_profile_id', v_ride.driver_id),
          jsonb_build_object('status', 'searching', 'offers_reopened', v_reopened), v_reason);

  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_ride.customer_id,
    'Buscando otro conductor',
    'Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo.',
    'ride', jsonb_build_object('reason', 'support_ride_released'));
  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_driver_user,
    'Soporte te quitó el viaje',
    'Estamos buscando otro conductor para este viaje. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes.',
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'release'));

  BEGIN
    PERFORM public.dispatch_ride(p_ride_id);
  EXCEPTION WHEN OTHERS THEN
    -- The release stands; retry_dispatch_expired_rides picks it up next minute.
    RAISE WARNING 'admin_release_active_ride: dispatch of ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_release_active_ride', v_admin, p_ride_id, 'dispatch_failed',
      jsonb_build_object('error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', 'searching');
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_release_active_ride(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_release_active_ride(uuid, text, uuid, text) TO authenticated, service_role;

-- 11. One step forward, standing in for the driver's tap. No GPS gate: that is
--     what support is for. "Viaje iniciado" takes the pickup time from the GPS
--     departure; with none, pickup = arrival, so no wait is charged. Returns
--     the times it wrote and the wait they give.
CREATE OR REPLACE FUNCTION public.admin_advance_active_ride(p_ride_id uuid, p_expected_status text,
  p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_new public.rides%ROWTYPE;
  v_driver_user uuid;
  v_to public.ride_status;
  v_body text;
  v_w record;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status IN ('accepted', 'driver_en_route') AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  IF v_ride.status IN ('accepted', 'driver_en_route') THEN
    v_to := 'arrived_at_pickup';
    v_body := 'Marcamos que llegaste al punto de recogida.';
    UPDATE public.rides
       SET status = v_to, driver_arrived_at = COALESCE(driver_arrived_at, now()), updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'arrived_at_pickup' THEN
    v_to := 'in_progress';
    v_body := 'Marcamos el viaje como iniciado.';
    UPDATE public.rides
       SET status = v_to,
           pickup_at = COALESCE(v_ride.pickup_at,
                                public._ride_gps_departure_at(p_ride_id, v_ride.driver_arrived_at),
                                v_ride.driver_arrived_at, now()),
           updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'in_progress' THEN
    v_to := 'arrived_at_destination';
    v_body := 'Marcamos que llegaste al destino.';
    UPDATE public.rides SET status = v_to, updated_at = now() WHERE id = p_ride_id;
  ELSE
    RETURN jsonb_build_object('error', 'ride_not_advanceable', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_new FROM public.rides WHERE id = p_ride_id;
  -- The wait these times give (0 before pickup): what completion will charge.
  SELECT * INTO v_w FROM public._wait_charge_for(v_new.service_type, v_new.driver_arrived_at, v_new.pickup_at);

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_advance_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at),
          jsonb_build_object('status', v_to, 'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
                             'wait_minutes', v_w.wait_minutes, 'wait_cup', v_w.charge),
          v_reason);

  -- The rider already gets the status push from notify_ride_status_change.
  PERFORM public._support_ride_push('admin_advance_active_ride', p_ride_id, v_driver_user,
    'Soporte actualizó tu viaje', v_body,
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'advance', 'status', v_to));

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_to,
    'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
    'wait_minutes', v_w.wait_minutes, 'billable_minutes', v_w.billable_minutes, 'wait_cup', v_w.charge);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_advance_active_ride(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_advance_active_ride(uuid, text, uuid, text) TO authenticated, service_role;

-- 12. Complete and charge: the agreed price minus the discount plus the recorded
--     wait, through complete_ride_and_pay (it admits admin callers and moves the
--     money exactly as for any ride). The amount must be the one support saw,
--     and a cargo ride needs its delivery proof.
CREATE OR REPLACE FUNCTION public.admin_complete_active_ride(p_ride_id uuid, p_expected_status text,
  p_expected_driver_id uuid, p_expected_total_cup integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_preview jsonb;
  v_status text;
  v_final integer;
  v_method text;
  v_row_cash integer;
  v_cash integer;
  v_wallet integer;
  v_pay jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RETURN jsonb_build_object('error', 'ride_not_completable', 'status', v_ride.status);
  END IF;
  -- tg_rides_require_delivery_proof lets admins through, so the proof a cargo
  -- ride needs (the recipient's code and the delivery photo) is checked here.
  IF COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
       SELECT 1 FROM public.delivery_details dd
       WHERE dd.ride_id = p_ride_id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL) THEN
    RETURN jsonb_build_object('error', 'delivery_proof_missing', 'status', v_ride.status);
  END IF;
  v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  IF v_preview IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agreed_price', 'status', v_ride.status);
  END IF;
  IF (v_preview->>'total_cup')::integer IS DISTINCT FROM p_expected_total_cup THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'status', v_ride.status,
                              'total_cup', (v_preview->>'total_cup')::integer);
  END IF;

  -- The distance does not change a ride with a snapshot: complete_ride_and_pay
  -- prefers the trail distance and only records it.
  PERFORM public.complete_ride_and_pay(p_ride_id, v_ride.driver_id,
                                       v_ride.estimated_distance_m, v_ride.estimated_duration_s);
  SELECT status::text, final_fare_cup, payment_method::text, COALESCE(cash_amount_cup, 0)
    INTO v_status, v_final, v_method, v_row_cash
  FROM public.rides WHERE id = p_ride_id;
  -- What support tells a driver whose app is down: how much to collect in cash.
  -- Derived from the ride row, not read from complete_ride_and_pay's result: its
  -- cash_amount_cup and wallet_amount_cup are 0 on a cash ride (it fills them
  -- only for a mixed ride, a split and the wallet shortfall of 00637, which turns
  -- the ride into a mixed one), yet the driver collects the whole fare. In the
  -- response, cash_amount_cup is the cash the driver collects and
  -- wallet_amount_cup what the wallets paid. The result is not read at all: a
  -- cast error here would roll back a payment that went through.
  v_cash := CASE v_method WHEN 'cash' THEN v_final WHEN 'mixed' THEN v_row_cash ELSE 0 END;
  v_wallet := CASE WHEN v_method IN ('tricicoin', 'mixed') THEN GREATEST(v_final - v_cash, 0) ELSE 0 END;
  v_pay := jsonb_build_object('final_fare_cup', v_final, 'payment_method', v_method,
                              'cash_amount_cup', v_cash, 'wallet_amount_cup', v_wallet);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_complete_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status),
          jsonb_build_object('status', v_status, 'preview', v_preview) || v_pay,
          v_reason);

  -- No support push: notify_ride_status_change already pushes both on 'completed'.
  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_status) || v_pay;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_complete_active_ride(uuid, text, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_complete_active_ride(uuid, text, uuid, integer, text) TO authenticated, service_role;

-- A copy pasted with Windows line ends puts \r in the function bodies. They run
-- the same, but their md5 no longer matches git. Rebuild them from the catalog.
DO $crlf$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', 'calculate_wait_charge', '_ride_gps_departure_at', '_active_ride_charge_preview',
      '_support_ride_push', '_reopen_ride_offers', 'release_rides_from_dead_drivers', 'admin_active_ride_context',
      'admin_release_active_ride', 'admin_advance_active_ride', 'admin_complete_active_ride')
      AND position(chr(13) IN p.prosrc) > 0
  LOOP
    EXECUTE replace(pg_get_functiondef(r.oid), chr(13), '');
  END LOOP;
END
$crlf$;

-- What this migration promises, checked in the database it just changed.
DO $verify$
DECLARE
  r record;
  v_n integer;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.calculate_wait_charge(uuid)'::regprocedure)
     IS DISTINCT FROM 'dcf518cffa45073e26fbd84833776bc5' THEN
    RAISE EXCEPTION '00660 check: calculate_wait_charge has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.release_rides_from_dead_drivers()'::regprocedure)
     IS DISTINCT FROM 'cdfaba6fef339647c23c7fcb0a6de317' THEN
    RAISE EXCEPTION '00660 check: release_rides_from_dead_drivers has an unexpected body';
  END IF;

  IF (SELECT allowed_roles FROM public.valid_transitions
       WHERE from_status = 'accepted' AND to_status = 'arrived_at_pickup')
     IS DISTINCT FROM ARRAY['admin', 'super_admin']::public.user_role[] THEN
    RAISE EXCEPTION '00660 check: accepted -> arrived_at_pickup must be for admin and super_admin only';
  END IF;

  -- The helpers that write run as their owner, with a fixed search_path; none
  -- of the five is callable by a client.
  v_n := 0;
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', '_ride_gps_departure_at', '_active_ride_charge_preview', '_support_ride_push',
      '_reopen_ride_offers')
  LOOP
    v_n := v_n + 1;
    IF r.proname IN ('_support_ride_push', '_reopen_ride_offers')
       AND NOT (r.prosecdef AND COALESCE(r.proconfig && ARRAY['search_path=public, pg_catalog'], false)) THEN
      RAISE EXCEPTION '00660 check: % is not SECURITY DEFINER with a fixed search_path', r.fn;
    END IF;
    IF has_function_privilege('anon', r.fn, 'EXECUTE') OR has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is executable by a client role', r.fn;
    END IF;
  END LOOP;
  IF v_n <> 5 THEN
    RAISE EXCEPTION '00660 check: expected 5 internal functions, found %', v_n;
  END IF;

  -- The four RPCs: SECURITY DEFINER with a fixed search_path, for signed-in
  -- callers only (each one checks is_admin() itself).
  v_n := 0;
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      'admin_active_ride_context', 'admin_release_active_ride', 'admin_advance_active_ride', 'admin_complete_active_ride')
  LOOP
    v_n := v_n + 1;
    IF NOT (r.prosecdef AND COALESCE(r.proconfig && ARRAY['search_path=public, pg_catalog',
                                                          'search_path=public, extensions, pg_catalog'], false)) THEN
      RAISE EXCEPTION '00660 check: % is not SECURITY DEFINER with a fixed search_path', r.fn;
    END IF;
    IF has_function_privilege('anon', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is executable by anon', r.fn;
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00660 check: % is not executable by authenticated', r.fn;
    END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION '00660 check: expected 4 admin functions, found %', v_n;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
      '_wait_charge_for', 'calculate_wait_charge', '_ride_gps_departure_at', '_active_ride_charge_preview',
      '_support_ride_push', '_reopen_ride_offers', 'release_rides_from_dead_drivers', 'admin_active_ride_context',
      'admin_release_active_ride', 'admin_advance_active_ride', 'admin_complete_active_ride')
      AND position(chr(13) IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION '00660 check: a function body still has a carriage return';
  END IF;
END
$verify$;

RESET lock_timeout;
