CREATE OR REPLACE FUNCTION public.admin_assign_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_active_id       uuid;
  v_afford          jsonb;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
  v_key             text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;
  -- As for an offer: stale_pre_pickup (00282) would cancel a ride accepted hours early.
  IF COALESCE(v_ride.is_scheduled, false) AND v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'scheduled_at', v_ride.scheduled_at);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  -- 00671: nobody assists a ride they ride in, or assigns a ride to themselves.
  IF v_admin = v_ride.customer_id OR v_admin = v_dp.user_id THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT COALESCE((SELECT u.is_active FROM public.users u WHERE u.id = v_dp.user_id), false) THEN
    RETURN jsonb_build_object('error', 'driver_inactive');
  END IF;
  IF NOT v_dp.is_online THEN
    RETURN jsonb_build_object('error', 'not_online');
  END IF;
  IF v_dp.last_heartbeat_at IS NOT NULL AND v_dp.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error', 'stale_heartbeat', 'last_heartbeat_at', v_dp.last_heartbeat_at);
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337).
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  SELECT a.id INTO v_active_id FROM public.rides a
   WHERE a.driver_id = v_dp.id
     AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
     AND a.id <> p_ride_id
   LIMIT 1;
  IF v_active_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'busy', 'active_ride_id', v_active_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = v_ride.service_type AND is_active) THEN
    RETURN jsonb_build_object('error', 'service_config_missing');
  END IF;

  v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    RETURN jsonb_build_object('error', 'insufficient_balance',
      'balance_trc', (v_afford->>'balance_trc')::int, 'required_trc', (v_afford->>'required_trc')::int);
  END IF;

  BEGIN
    UPDATE public.rides
       SET driver_id              = v_dp.id,
           status                 = 'accepted',
           accepted_at            = now(),
           driver_custom_rate_cup = v_dp.custom_per_km_rate_cup
     WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION WHEN unique_violation THEN
    -- rides_one_active_per_driver: the driver took another ride a moment ago.
    RETURN jsonb_build_object('error', 'busy', 'race', true);
  END;

  UPDATE public.ride_offers SET status = 'accepted', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id = v_dp.id AND status = 'pending';
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id <> v_dp.id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_assign_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', 'searching'),
          jsonb_build_object('status', 'accepted', 'driver_profile_id', v_dp.id),
          v_reason);

  -- The driver's push. Category system is always delivered; send-push overwrites data.type with
  -- the category, so the event travels in data.event. Driver apps from 1.7.4 load the trip when
  -- it arrives; older ones load it when the app comes back to the foreground. In a block of its
  -- own, like notify_driver_new_offer: a failing push must not take back the assignment.
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING 'admin_assign_ride_to_driver: no service role key, no push for ride %', p_ride_id;
      PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
        jsonb_build_object('driver_profile_id', v_dp.id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('support-assign-push',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object(
          'user_id', v_dp.user_id::text,
          'title', 'Soporte te asignó un viaje',
          'body', 'Recogida: ' || left(COALESCE(v_ride.pickup_address, '—'), 60)
                  || ' · ' || COALESCE(v_ride.estimated_fare_cup, 0) || ' CUP. Abre la app.',
          'category', 'system',
          'data', jsonb_build_object('event', 'ride_assigned', 'ride_id', p_ride_id::text)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'admin_assign_ride_to_driver: the push for ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
      jsonb_build_object('driver_profile_id', v_dp.id, 'error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'driver_profile_id', v_dp.id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_ride_assist_candidates(p_ride_id uuid, p_service_type text DEFAULT NULL::text)
 RETURNS TABLE(driver_profile_id uuid, full_name text, phone text, vehicle_type vehicle_type, vehicle_label text, is_online boolean, last_heartbeat_at timestamp with time zone, distance_m integer, busy_ride_id uuid, can_afford boolean, offer_status text, offer_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_ride  public.rides%ROWTYPE;
  v_type  text;
  v_types public.vehicle_type[];
  v_cargo boolean;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_type  := COALESCE(p_service_type, v_ride.service_type);
  v_types := public._vehicle_types_for_service(v_type);
  v_cargo := (v_ride.ride_mode = 'cargo' OR v_type = 'mensajeria');

  RETURN QUERY
  SELECT dp.id,
         u.full_name,
         u.phone,
         v.type,
         -- A NULL or blank field drops out instead of blanking the whole label.
         concat_ws(' · ', NULLIF(concat_ws(' ', NULLIF(btrim(v.make), ''), NULLIF(btrim(v.model), '')), ''),
                   NULLIF(btrim(v.color), ''), NULLIF(btrim(v.plate_number), '')),
         dp.is_online,
         dp.last_heartbeat_at,
         ST_Distance(dp.current_location, v_ride.pickup_location)::int,
         (SELECT a.id FROM public.rides a
           WHERE a.driver_id = dp.id
             AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
           LIMIT 1),
         COALESCE((public.driver_can_afford_commission(dp.id, v_ride.estimated_fare_cup)->>'ok')::boolean, false),
         o.status,
         o.expires_at
  FROM public.driver_profiles dp
  JOIN public.users u ON u.id = dp.user_id
  JOIN LATERAL (
    SELECT v2.* FROM public.vehicles v2
    WHERE v2.driver_id = dp.id
      AND v2.is_active
      AND (v_types IS NULL OR v2.type = ANY (v_types))
      AND (NOT v_cargo OR v2.accepts_cargo IS TRUE)
    ORDER BY v2.created_at DESC
    LIMIT 1
  ) v ON true
  LEFT JOIN public.ride_offers o ON o.ride_id = v_ride.id AND o.driver_profile_id = dp.id
  WHERE dp.status = 'approved'
    AND u.is_active
    AND (dp.is_online OR dp.last_heartbeat_at > now() - interval '7 days')
    AND NOT public._users_blocked(v_ride.customer_id, dp.user_id)
  ORDER BY dp.is_online DESC, ST_Distance(dp.current_location, v_ride.pickup_location) ASC NULLS LAST, u.full_name
  LIMIT 60;
END;
$function$
;
