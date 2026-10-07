CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$function$
;

CREATE OR REPLACE FUNCTION public.accept_ride_v2(p_ride_id uuid, p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid             uuid;
  v_ride                   rides%ROWTYPE;
  v_driver                 driver_profiles%ROWTYPE;
  v_existing_active        rides%ROWTYPE;
  v_offer                  ride_offers%ROWTYPE;
  v_svc_config             record;
  v_custom_rate            numeric;
  v_log_meta               jsonb;
  v_fleet_required         boolean := false;
  v_driver_in_fleet        boolean := false;
  v_afford                 jsonb;   -- 00367: commission affordability result
BEGIN
  v_caller_uid := auth.uid();
  v_log_meta   := jsonb_build_object('driver_profile_id', p_driver_id);

  IF v_caller_uid IS NULL THEN
    PERFORM log_rpc_attempt('accept_ride_v2', NULL, p_ride_id, 'unauthenticated', v_log_meta);
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = p_driver_id AND user_id = v_caller_uid
  ) THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'unauthorized', v_log_meta);
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'ride_not_found', v_log_meta);
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.driver_id = p_driver_id AND v_ride.status IN
     ('accepted','driver_en_route','arrived_at_pickup','in_progress') THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'idempotent', v_log_meta);
    RETURN jsonb_build_object(
      'success', true,
      'ride_id', p_ride_id,
      'idempotent', true,
      'estimated_fare_cup', v_ride.estimated_fare_cup,
      'estimated_fare_trc', v_ride.estimated_fare_trc,
      'driver_custom_rate_cup', v_ride.driver_custom_rate_cup
    );
  END IF;

  IF v_ride.status <> 'searching' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'ride_already_taken',
      v_log_meta || jsonb_build_object('current_status', v_ride.status));
    RETURN jsonb_build_object('error','ride_already_taken','status',v_ride.status);
  END IF;

  SELECT * INTO v_offer FROM ride_offers
  WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_id
    AND status = 'pending' AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'offer_not_found_or_expired', v_log_meta);
    RETURN jsonb_build_object('error','offer_not_found_or_expired');
  END IF;

  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_found', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_found');
  END IF;

  IF v_driver.status <> 'approved' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_approved',
      v_log_meta || jsonb_build_object('driver_status', v_driver.status));
    RETURN jsonb_build_object('error','driver_not_approved','driver_status',v_driver.status);
  END IF;

  IF NOT v_driver.is_online THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_online', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL
     AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_stale_heartbeat', v_log_meta);
    RETURN jsonb_build_object('error','driver_stale_heartbeat');
  END IF;

  -- 00337 — Fleet membership gate.
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_fleet_required;

    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM fleet_members fm
        JOIN driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_driver.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;

      IF NOT v_driver_in_fleet THEN
        PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'not_in_fleet',
          v_log_meta || jsonb_build_object(
            'corporate_account_id', v_ride.corporate_account_id,
            'driver_user_id', v_driver.user_id
          ));
        RETURN jsonb_build_object(
          'error', 'not_in_fleet',
          'corporate_account_id', v_ride.corporate_account_id
        );
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_existing_active FROM rides
  WHERE driver_id = p_driver_id
    AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    AND id <> p_ride_id
  LIMIT 1;

  IF FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_has_active_ride',
      v_log_meta || jsonb_build_object('active_ride_id', v_existing_active.id));
    RETURN jsonb_build_object('error','driver_has_active_ride','active_ride_id',v_existing_active.id);
  END IF;

  -- Validate the service type is configured (defensive). We do NOT use these
  -- rates to recompute the fare anymore.
  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc_config
  FROM service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'service_config_missing', v_log_meta);
    RETURN jsonb_build_object('error','service_config_missing');
  END IF;

  v_custom_rate := v_driver.custom_per_km_rate_cup;

  -- 00377: NO recalcular el estimado. estimated_fare_cup/trc son el CONTRATO
  -- (createRide TS + snapshot 00299). Restaura el diseño de 00299.

  -- 00367 — Commission affordability gate. Usa el BRUTO existente.
  v_afford := driver_can_afford_commission(p_driver_id, v_ride.estimated_fare_cup);
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'insufficient_balance',
      v_log_meta || v_afford);
    RETURN jsonb_build_object(
      'error',           'insufficient_balance',
      'balance_trc',     (v_afford->>'balance_trc')::int,
      'required_trc',    (v_afford->>'required_trc')::int,
      'commission_rate', (v_afford->>'commission_rate')::numeric
    );
  END IF;

  BEGIN
    UPDATE rides SET
      driver_id              = p_driver_id,
      status                 = 'accepted',
      accepted_at            = now(),
      driver_custom_rate_cup = v_custom_rate
      -- 00377: NO TOCAR estimated_fare_cup, estimated_fare_trc.
    WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION
    WHEN unique_violation THEN
      SELECT * INTO v_existing_active FROM rides
      WHERE driver_id = p_driver_id
        AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
        AND id <> p_ride_id
      LIMIT 1;
      PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_has_active_ride_race',
        v_log_meta || jsonb_build_object('active_ride_id', v_existing_active.id));
      RETURN jsonb_build_object(
        'error','driver_has_active_ride',
        'active_ride_id', v_existing_active.id,
        'race', true
      );
  END;

  UPDATE ride_offers SET status = 'accepted',   responded_at = now() WHERE id = v_offer.id;
  UPDATE ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND id <> v_offer.id AND status = 'pending';

  PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'success',
    v_log_meta || jsonb_build_object(
      'estimated_fare_cup', v_ride.estimated_fare_cup,
      'estimated_fare_trc', v_ride.estimated_fare_trc
    ));

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'estimated_fare_cup', v_ride.estimated_fare_cup,
    'estimated_fare_trc', v_ride.estimated_fare_trc,
    'driver_custom_rate_cup', v_custom_rate
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride         rides%ROWTYPE;
  v_pickup_lat   double precision;
  v_pickup_lng   double precision;
  v_is_delivery  boolean;
  v_count        int := 0;
  v_round        int;
  v_offer_ttl_s  int;
  v_rider_rating numeric;
  v_threshold    numeric;
  v_limit        int;
  v_eff_radius   int;
  v_gated        boolean := false;
  v_reoffer_cooldown_s int;
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
  v_is_delivery := (v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria');

  -- 00512: a cargo ride is INSERTed before its delivery_details row exists, and
  -- this runs inside the ride's own INSERT trigger. Dispatching now would mean
  -- dispatching without the package specs. Defer; trg_dispatch_on_delivery_details
  -- re-dispatches as soon as the specs land.
  IF v_is_delivery AND NOT EXISTS (
    SELECT 1 FROM delivery_details dd WHERE dd.ride_id = p_ride_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'offers_created', 0,
                              'dispatch_round', v_ride.dispatch_round,
                              'deferred', 'awaiting_delivery_details');
  END IF;
  v_round := v_ride.dispatch_round + 1;

  -- 00524: radius and candidate limit come from config, not from the caller.
  -- 0 = unlimited/all (the low-supply default). The p_radius_m parameter is
  -- retained only so existing callers (insert trigger, retry cron, driver-online
  -- dispatcher) keep compiling.
  v_eff_radius := CASE WHEN get_platform_config_numeric('dispatch_stage1_seconds', 45) > 0  AND get_platform_config_numeric('dispatch_stage1_radius_m', 8000) > 0  AND v_ride.created_at > now() - make_interval(secs => get_platform_config_numeric('dispatch_stage1_seconds', 45)) THEN GREATEST(0, get_platform_config_numeric('dispatch_stage1_radius_m', 8000))::int ELSE GREATEST(0, get_platform_config_numeric('dispatch_max_radius_m', 0))::int END;
  v_limit      := GREATEST(0, get_platform_config_numeric('dispatch_offer_limit', 0))::int;
  v_reoffer_cooldown_s := GREATEST(0, get_platform_config_numeric('reoffer_cooldown_s', 120))::int;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  -- Soft low-rating rider gate (first round only)
  v_threshold := get_platform_config_numeric('low_rating_rider_threshold', 3.0);
  IF v_round = 1 AND v_threshold > 0 THEN
    SELECT cp.rating_avg INTO v_rider_rating
      FROM customer_profiles cp WHERE cp.user_id = v_ride.customer_id;
    IF v_rider_rating IS NOT NULL AND v_rider_rating < v_threshold THEN
      v_gated := true;
      v_limit := GREATEST(1, get_platform_config_numeric('low_rating_rider_dispatch_limit', 5)::int);
      v_eff_radius := GREATEST(500, get_platform_config_numeric('low_rating_rider_radius_m', 3000)::int);
    END IF;
  END IF;

  -- 00524: EXPIRED offers past the cooldown re-arm (status back to 'pending',
  -- fresh TTL) so a distracted driver rings again while the ride keeps
  -- searching. Rejected/accepted/superseded offers are never touched.
  -- trg_notify_driver_reoffer (below) re-fires the push for re-arms.
  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    v_limit,
    v_eff_radius,
    v_is_delivery,
    v_ride.estimated_distance_m,
    (SELECT dd.package_category  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.estimated_weight_kg FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_length_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_width_cm  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_height_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    v_ride.corporate_account_id
  ) fbd
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = v_ride.customer_id AND ub.blocked_id = fbd.user_id)
       OR (ub.blocker_id = fbd.user_id AND ub.blocked_id = v_ride.customer_id)
  )
  ON CONFLICT (ride_id, driver_profile_id) DO UPDATE
    SET status          = 'pending',
        expires_at      = EXCLUDED.expires_at,
        composite_score = EXCLUDED.composite_score,
        distance_m      = EXCLUDED.distance_m,
        responded_at    = NULL
    WHERE ride_offers.status = 'expired'
      AND ride_offers.expires_at < now() - make_interval(secs => v_reoffer_cooldown_s);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s,
                            'low_rating_gated', v_gated);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.driver_can_afford_commission(p_driver_id uuid, p_estimated_fare_cup integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id              uuid;
  v_balance_cup          integer;
  v_commission_rate      numeric;
  v_required_cup         integer;
BEGIN
  SELECT user_id INTO v_user_id FROM driver_profiles WHERE id = p_driver_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_not_found');
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance_cup
  FROM wallet_accounts
  WHERE user_id = v_user_id
    AND account_type = 'tricicoin';
  v_balance_cup := COALESCE(v_balance_cup, 0);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_required_cup := CEIL(COALESCE(p_estimated_fare_cup, 0)::numeric * v_commission_rate)::int;

  RETURN jsonb_build_object(
    'ok',              v_balance_cup >= v_required_cup,
    'balance_trc',     v_balance_cup,
    'required_trc',    v_required_cup,
    'balance_cup',     v_balance_cup,
    'required_cup',    v_required_cup,
    'commission_rate', v_commission_rate,
    'wallet_type',     'tricicoin'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT is_admin() INTO v_is_admin;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;
  v_is_customer := (OLD.customer_id = v_caller_uid);
  v_is_driver := (OLD.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = OLD.driver_id AND user_id = v_caller_uid
  ));
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;

  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    IF OLD.final_fare_cup IS NULL
       AND NEW.final_fare_cup IS NOT NULL
       AND OLD.status IN ('in_progress','arrived_at_destination')
       AND NEW.status = 'completed' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
    END IF;
  END IF;

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;
  IF v_is_driver AND NOT v_is_customer THEN
    IF NEW.estimated_fare_cup IS DISTINCT FROM OLD.estimated_fare_cup
       OR NEW.estimated_fare_trc IS DISTINCT FROM OLD.estimated_fare_trc
       OR NEW.estimated_distance_m IS DISTINCT FROM OLD.estimated_distance_m
       OR NEW.estimated_duration_s IS DISTINCT FROM OLD.estimated_duration_s THEN
      RAISE EXCEPTION 'driver cannot modify ride estimates';
    END IF;
    IF NEW.pickup_location::text IS DISTINCT FROM OLD.pickup_location::text
       OR NEW.dropoff_location::text IS DISTINCT FROM OLD.dropoff_location::text
       OR NEW.pickup_address IS DISTINCT FROM OLD.pickup_address
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;
  IF v_is_customer AND NOT v_is_driver THEN
    IF NEW.driver_arrived_at IS DISTINCT FROM OLD.driver_arrived_at
       OR NEW.pickup_at IS DISTINCT FROM OLD.pickup_at
       OR NEW.arrived_at_destination_at IS DISTINCT FROM OLD.arrived_at_destination_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'customer cannot modify driver timestamps';
    END IF;
    IF NEW.actual_distance_m IS DISTINCT FROM OLD.actual_distance_m
       OR NEW.actual_duration_s IS DISTINCT FROM OLD.actual_duration_s THEN
      RAISE EXCEPTION 'customer cannot modify actuals';
    END IF;
    -- CLI-001: pricing fields used as source of truth by complete_ride_and_pay
    IF NEW.surge_multiplier IS DISTINCT FROM OLD.surge_multiplier
       OR NEW.driver_custom_rate_cup IS DISTINCT FROM OLD.driver_custom_rate_cup
       OR NEW.wallet_ratio IS DISTINCT FROM OLD.wallet_ratio
       OR NEW.insurance_premium_cup IS DISTINCT FROM OLD.insurance_premium_cup
       OR NEW.wait_time_charge_cup IS DISTINCT FROM OLD.wait_time_charge_cup THEN
      RAISE EXCEPTION 'customer cannot modify pricing fields (surge_multiplier, driver_custom_rate_cup, wallet_ratio, insurance_premium_cup, wait_time_charge_cup)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.find_best_drivers(p_pickup_lat double precision, p_pickup_lng double precision, p_service_type text, p_limit integer DEFAULT 5, p_radius_m integer DEFAULT 5000, p_is_delivery boolean DEFAULT false, p_estimated_trip_distance_m integer DEFAULT NULL::integer, p_package_category text DEFAULT NULL::text, p_estimated_weight_kg numeric DEFAULT NULL::numeric, p_package_length_cm integer DEFAULT NULL::integer, p_package_width_cm integer DEFAULT NULL::integer, p_package_height_cm integer DEFAULT NULL::integer, p_corporate_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, distance_m double precision, match_score numeric, rating numeric, acceptance_rate numeric, composite double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_types vehicle_type[];
  v_is_long_trip BOOLEAN;
  v_use_fleet_restriction BOOLEAN := false;
  v_hb_window_s NUMERIC;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  -- 00524: heartbeat freshness window from config. 0 (default) = no filter —
  -- with offers going to ALL candidates in parallel, a stale-GPS driver blocks
  -- nobody (the offer just expires). Setting N>0 restores the R5 hardening.
  v_hb_window_s := get_platform_config_numeric('dispatch_heartbeat_window_s', 0);

  v_vehicle_types := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::vehicle_type]
  END;

  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  IF p_corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = p_corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_use_fleet_restriction;
  END IF;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id              AS dp_id,
      dp.user_id         AS dp_user_id,
      dp.match_score     AS dp_match_score,
      dp.rating_avg      AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
        FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status = 'completed'
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND r.accepted_at IS NOT NULL
      )::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id
    WHERE dp.is_online = true
      AND (
        v_hb_window_s <= 0
        OR dp.last_heartbeat_at IS NULL
        OR dp.last_heartbeat_at > now() - make_interval(secs => v_hb_window_s)
      )
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND (
        p_package_category IS NULL
        OR (
          v.accepted_cargo_categories IS NOT NULL
          AND array_length(v.accepted_cargo_categories, 1) > 0
          AND p_package_category = ANY(v.accepted_cargo_categories::text[])
        )
      )
      AND (
        p_estimated_weight_kg IS NULL
        OR (v.max_cargo_weight_kg IS NOT NULL AND v.max_cargo_weight_kg >= p_estimated_weight_kg)
      )
      AND (
        p_package_length_cm IS NULL
        OR (v.max_cargo_length_cm IS NOT NULL AND v.max_cargo_length_cm >= p_package_length_cm)
      )
      AND (
        p_package_width_cm IS NULL
        OR (v.max_cargo_width_cm IS NOT NULL AND v.max_cargo_width_cm >= p_package_width_cm)
      )
      AND (
        p_package_height_cm IS NULL
        OR (v.max_cargo_height_cm IS NOT NULL AND v.max_cargo_height_cm >= p_package_height_cm)
      )
      AND (p_radius_m <= 0 OR ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)) AND ST_Y(dp.current_location::geometry) BETWEEN 19.3 AND 23.7 AND ST_X(dp.current_location::geometry) BETWEEN -85.2 AND -73.8
      AND (c.id IS NULL OR c.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
      AND (
        NOT v_use_fleet_restriction
        OR EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = p_corporate_account_id
            AND fm.driver_id = dp.user_id
            AND fm.status = 'active'
        )
      )
  )
  SELECT
    ed.dp_id, ed.dp_user_id, ed.dist_m,
    ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (
      0.30 * (1.0 - LEAST(ed.dist_m / GREATEST(p_radius_m, 10000)::DOUBLE PRECISION, 1.0)) +
      0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
      0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
      0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
      0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
      0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT (CASE WHEN p_limit > 0 THEN p_limit END);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric DEFAULT NULL::numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;

  -- `#>> '{}'` unwraps the JSONB scalar safely whether it was written
  -- as a string ('"0.15"') or as a JSON number (0.15). Cast to NUMERIC
  -- after.
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;

  RETURN COALESCE(v_out, p_fallback);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_platform_config_text(p_key text, p_fallback text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN COALESCE(v_raw #>> '{}', p_fallback);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_driver_new_offer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_driver_user_id UUID;
  v_ride           rides%ROWTYPE;
  v_service_key    TEXT;
  v_headers        JSONB;
  v_trip_km        NUMERIC;
  v_pickup_short   TEXT;
  v_title          TEXT;
  v_body           TEXT;
  v_fare_label     TEXT;
BEGIN
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles
  WHERE id = NEW.driver_profile_id;

  IF v_driver_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Trip distance (pickup -> dropoff), not driver->pickup. Always
  -- populated for a real ride; never the misleading "0.0 km".
  v_trip_km := ROUND(COALESCE(v_ride.estimated_distance_m, 0)::numeric / 1000.0, 1);

  v_pickup_short := LEFT(COALESCE(v_ride.pickup_address, ''), 50);
  IF LENGTH(COALESCE(v_ride.pickup_address, '')) > 50 THEN
    v_pickup_short := v_pickup_short || '…';
  END IF;

  v_fare_label := COALESCE(v_ride.estimated_fare_cup, 0)::TEXT || ' CUP';

  v_title := 'Viaje disponible cerca';
  v_body  := 'Recogida: ' || v_pickup_short
    || CASE WHEN v_trip_km > 0 THEN ' · Viaje ' || v_trip_km || ' km' ELSE '' END
    || ' · ' || v_fare_label;

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
      'user_id',  v_driver_user_id::text,
      'title',    v_title,
      'body',     v_body,
      'category', 'ride_offer',
      'data', jsonb_build_object(
        'type',       'ride_offer',
        'ride_id',    NEW.ride_id::text,
        'offer_id',   NEW.id::text,
        'expires_at', NEW.expires_at,
        'service_type', v_ride.service_type
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_driver_new_offer] exception for offer %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.rides_sync_coords()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.pickup_location IS NOT NULL THEN
    NEW.pickup_lat := ST_Y(NEW.pickup_location::geometry);
    NEW.pickup_lng := ST_X(NEW.pickup_location::geometry);
  END IF;
  IF NEW.dropoff_location IS NOT NULL THEN
    NEW.dropoff_lat := ST_Y(NEW.dropoff_location::geometry);
    NEW.dropoff_lng := ST_X(NEW.dropoff_location::geometry);
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_ride_offer_increment_offered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM set_config('app.trusted_driver_update', '1', true);
  UPDATE driver_profiles
     SET total_rides_offered = COALESCE(total_rides_offered, 0) + 1
   WHERE id = NEW.driver_profile_id;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_ride_offer_refresh_acceptance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_total    integer;
  v_accepted integer;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_total
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id;

  SELECT COUNT(*) INTO v_accepted
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id
    AND status = 'accepted';

  PERFORM set_config('app.trusted_driver_update', '1', true);
  UPDATE driver_profiles
     SET acceptance_rate = CASE
       WHEN v_total = 0 THEN 100.0
       ELSE LEAST(100.0, ROUND(100.0 * v_accepted::numeric / v_total, 1))
     END
   WHERE id = NEW.driver_profile_id;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_svc                  RECORD;
  v_commission_rate      NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_eff_per_km           INTEGER;
  v_commission_amount    INTEGER;
  v_rule_id              uuid;
  v_now_t                time;
  v_now_dow              int;
BEGIN
  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_pricing_snapshots
    WHERE ride_id = NEW.id AND snapshot_type = 'estimate'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_svc
  FROM public.service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_now_t   := (now() AT TIME ZONE 'America/Havana')::time;
    v_now_dow := EXTRACT(dow FROM now() AT TIME ZONE 'America/Havana')::int;
    SELECT pr.id INTO v_rule_id
    FROM public.pricing_rules pr
    WHERE pr.service_type = NEW.service_type
      AND pr.is_active = true
      AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
           CASE WHEN pr.time_window_start <= pr.time_window_end
                THEN v_now_t >= pr.time_window_start AND v_now_t < pr.time_window_end
                ELSE v_now_t >= pr.time_window_start OR v_now_t < pr.time_window_end END)
      AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
           OR v_now_dow = ANY(pr.day_of_week))
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_rule_id := NULL;
  END;

  v_eff_per_km := COALESCE(NEW.driver_custom_rate_cup, v_svc.per_km_rate_cup);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM public.platform_config WHERE key = 'commission_rate';
  -- Guard: 0 / NULL / out-of-range (>=1) is invalid -> fall back to 15%.
  IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
    v_commission_rate := 0.15;
  END IF;

  IF NEW.corporate_account_id IS NOT NULL THEN
    SELECT commission_percent / 100.0 INTO v_corp_commission_rate
    FROM public.corporate_accounts WHERE id = NEW.corporate_account_id;
  END IF;

  IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_corp_commission_rate)::int;
  ELSE
    v_commission_amount := ROUND(NEW.estimated_fare_cup * v_commission_rate)::int;
  END IF;

  INSERT INTO public.ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc,
    min_fare, corporate_commission_rate, default_commission_rate_snapshot
  ) VALUES (
    NEW.id, 'estimate',
    v_svc.base_fare_cup, v_eff_per_km, v_svc.per_minute_rate_cup,
    NEW.estimated_distance_m, NEW.estimated_duration_s, NEW.surge_multiplier,
    NEW.estimated_fare_cup,
    COALESCE(v_corp_commission_rate, v_commission_rate),
    v_commission_amount,
    NEW.estimated_fare_cup,
    v_rule_id,
    NEW.exchange_rate_usd_cup, NEW.estimated_fare_trc,
    v_svc.min_fare_cup, v_corp_commission_rate, v_commission_rate
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_rides_create_estimate_snapshot failed for ride %: % %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_rides_validate_insurance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_pct numeric; v_min integer;
BEGIN
  IF NEW.insurance_selected IS TRUE THEN
    SELECT premium_pct, min_premium_cup INTO v_pct, v_min
    FROM trip_insurance_configs
    WHERE service_type = NEW.service_type AND is_active = true
    LIMIT 1;
    IF v_pct IS NULL THEN
      NEW.insurance_selected    := false;
      NEW.insurance_premium_cup := 0;
    ELSE
      NEW.insurance_premium_cup := GREATEST(COALESCE(v_min, 0), ROUND(COALESCE(NEW.estimated_fare_cup, 0) * v_pct))::integer;
    END IF;
  ELSE
    NEW.insurance_premium_cup := 0;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo RECORD;
  v_type TEXT;
  v_correct_discount INTEGER := 0;
  v_slot_claimed BOOLEAN := false;
  v_supplied_discount INTEGER := COALESCE(NEW.discount_amount_cup, 0);
  v_shared_discount INTEGER := 0;
  v_cap INTEGER;
  v_occ INTEGER;
  v_free INTEGER;
  v_pct NUMERIC;
  v_fare_base INTEGER;   -- 00399: immutable fare base for ALL discount math
  -- 00559: partner-place discount
  v_partner_discount INTEGER := 0;
  v_partner_id UUID;
  v_partner_pct NUMERIC;
  v_commission_rate NUMERIC;
  v_corp_rate NUMERIC;
BEGIN
  -- 00492: deleting a promotion cascades ON DELETE SET NULL onto
  -- rides.promo_code_id. On an already-finished ride, preserve the historical
  -- discount instead of recomputing it to 0.
  -- 00559: returns BEFORE the partner block on purpose — a finished ride keeps
  -- its historical partner_discount_cup / partner_place_id untouched.
  IF TG_OP = 'UPDATE'
     AND OLD.promo_code_id IS NOT NULL
     AND NEW.promo_code_id IS NULL
     AND NEW.status IN ('completed', 'canceled') THEN
    RETURN NEW;
  END IF;

  v_fare_base := COALESCE(
    (SELECT total FROM ride_pricing_snapshots
       WHERE ride_id = NEW.id AND snapshot_type = 'estimate' LIMIT 1),
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.estimated_fare_cup ELSE NEW.estimated_fare_cup END,
    0
  );

  IF COALESCE(NEW.shared_ride, false) AND NEW.service_type = 'triciclo_basico' THEN
    v_cap := COALESCE((SELECT max_passengers FROM service_type_configs WHERE slug = NEW.service_type), 4);
    v_occ := LEAST(GREATEST(COALESCE(NEW.shared_ride_seats_occupied, 1), 1), v_cap - 1);
    v_free := GREATEST(v_cap - v_occ, 0);
    v_pct := get_platform_config_numeric('shared_ride_discount_per_seat_pct', 7);
    NEW.shared_ride_seats_occupied := v_occ;
    v_shared_discount := LEAST(
      FLOOR(v_fare_base * v_free * v_pct / 100.0)::INTEGER,
      v_fare_base
    );
    NEW.shared_ride_discount_cup := v_shared_discount;
  ELSE
    NEW.shared_ride := false;
    NEW.shared_ride_seats_occupied := NULL;
    NEW.shared_ride_discount_cup := 0;
  END IF;

  -- ── 00559: descuento de lugar aliado ────────────────────────────────
  -- Derivado del destino, jamás de lo que manda el cliente.
  -- El tope en la comisión efectiva NO es cosmético: con tarifa F, comisión c y
  -- descuento d, el neto de la plataforma es F(c−d), que solo es >= 0 mientras
  -- d <= c. Sin este tope, un lugar al 50% haría que la plataforma pusiera
  -- plata propia.
  v_partner_discount := 0;
  NEW.partner_place_id := NULL;

  IF NEW.dropoff_location IS NOT NULL AND v_fare_base > 0 AND COALESCE(NEW.ride_mode, 'passenger') = 'passenger' THEN
    SELECT pp.id, pp.discount_percent
      INTO v_partner_id, v_partner_pct
    FROM public.partner_places pp
    WHERE pp.is_active
      AND (pp.valid_until IS NULL OR pp.valid_until > now())
      AND ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)
    ORDER BY ST_Distance(pp.location, NEW.dropoff_location)  -- radios solapados: gana el más cercano
    LIMIT 1;

    IF v_partner_id IS NOT NULL THEN
      v_commission_rate := get_platform_config_numeric('commission_rate', 0.15);
      -- guarda de 00494: una comisión 0/NULL/>=1 es config inválida, no "gratis"
      IF v_commission_rate IS NULL OR v_commission_rate <= 0 OR v_commission_rate >= 1 THEN
        v_commission_rate := 0.15;
      END IF;

      -- En corporativo la plataforma cobra la comisión corporativa, que es
      -- menor: el tope baja solo para que el invariante siga valiendo.
      IF NEW.corporate_account_id IS NOT NULL THEN
        SELECT commission_percent / 100.0 INTO v_corp_rate
        FROM public.corporate_accounts WHERE id = NEW.corporate_account_id;
        IF v_corp_rate IS NOT NULL AND v_corp_rate < v_commission_rate THEN
          v_commission_rate := v_corp_rate;
        END IF;
      END IF;

      v_partner_discount := GREATEST(LEAST(
        ROUND(v_fare_base * v_partner_pct / 100.0)::INTEGER,
        ROUND(v_fare_base * v_commission_rate)::INTEGER
      ), 0);

      IF v_partner_discount > 0 THEN
        NEW.partner_place_id := v_partner_id;
      END IF;
    END IF;
  END IF;

  IF is_super_admin() THEN
    IF v_supplied_discount <> 0 OR NEW.promo_code_id IS NOT NULL THEN
      INSERT INTO admin_promo_audit_log (
        admin_user_id, ride_id, customer_id,
        promo_code_id, discount_amount_cup_supplied,
        estimated_fare_cup, notes
      ) VALUES (
        auth.uid(), NEW.id, NEW.customer_id,
        NEW.promo_code_id, v_supplied_discount,
        NEW.estimated_fare_cup,
        format('TG_OP=%s super_admin bypass', TG_OP)
      );
    END IF;
    -- 00559: el bypass sigue dejando pasar discount_amount_cup sin recomputar
    -- (escape hatch deliberado para soporte), pero la atribución al lugar se
    -- escribe con el valor del servidor, no con el que mandó el cliente.
    NEW.partner_discount_cup := v_partner_discount;
    RETURN NEW;
  END IF;

  IF NEW.promo_code_id IS NULL THEN
    NEW.partner_discount_cup := v_partner_discount;
    NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
    RETURN NEW;
  END IF;

  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

  IF v_promo IS NULL
     OR NOT v_promo.is_active
     OR v_promo.valid_from > NOW()
     OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())
     -- 00482: first-ride-only promos are invalid once the customer has a completed ride
     OR (COALESCE(v_promo.first_ride_only, false) AND EXISTS (
       SELECT 1 FROM rides r0 WHERE r0.customer_id = NEW.customer_id AND r0.status = 'completed'
     ))
  THEN
    NEW.promo_code_id := NULL;
    NEW.partner_discount_cup := v_partner_discount;
    NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)
      VALUES (v_promo.id, NEW.customer_id, NEW.id);
    EXCEPTION WHEN unique_violation THEN
      NEW.promo_code_id := NULL;
      NEW.partner_discount_cup := v_partner_discount;
      NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
      RETURN NEW;
    END;

    UPDATE promotions
    SET current_uses = current_uses + 1
    WHERE id = v_promo.id
      AND (max_uses IS NULL OR current_uses < max_uses)
    RETURNING true INTO v_slot_claimed;

    IF NOT COALESCE(v_slot_claimed, false) THEN
      DELETE FROM promotion_uses
      WHERE promotion_id = v_promo.id
        AND user_id = NEW.customer_id
        AND ride_id = NEW.id;
      NEW.promo_code_id := NULL;
      NEW.partner_discount_cup := v_partner_discount;
      NEW.discount_amount_cup := LEAST(v_partner_discount + v_shared_discount, v_fare_base);
      RETURN NEW;
    END IF;
  END IF;

  v_type := v_promo.type::TEXT;

  IF v_type IN ('percentage_discount', 'bonus_credit') THEN
    v_correct_discount := LEAST(
      ROUND(v_fare_base * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      v_fare_base
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_correct_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      v_fare_base
    );
  ELSE
    v_correct_discount := 0;
  END IF;

  -- 00559: promo y lugar aliado NO se suman — gana el mayor. El perdedor aporta
  -- 0 para que el subsidio de 00481 no cuente dos veces el mismo descuento.
  IF v_partner_discount > GREATEST(v_correct_discount, 0) THEN
    NEW.partner_discount_cup := v_partner_discount;
    v_correct_discount := 0;
  ELSE
    NEW.partner_discount_cup := 0;
    NEW.partner_place_id := NULL;
  END IF;

  NEW.discount_amount_cup := LEAST(
    GREATEST(v_correct_discount, 0) + NEW.partner_discount_cup + v_shared_discount,
    v_fare_base
  );
  RETURN NEW;
END;
$function$
;

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
  SELECT ((value #>> '{}')::INTEGER) INTO v_abandon
  FROM platform_config WHERE key = 'searching_abandon_seconds';
  v_abandon := COALESCE(v_abandon, 180);

  UPDATE rides
  SET status = 'canceled',
      cancellation_reason = 'searching_abandoned',
      canceled_at = now()
  WHERE status = 'searching'
    AND CASE
          WHEN is_scheduled = TRUE AND scheduled_at IS NOT NULL
            THEN scheduled_at     < now() - (v_abandon || ' seconds')::interval
          ELSE     searching_seen_at < now() - (v_abandon || ' seconds')::interval
        END;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
;

