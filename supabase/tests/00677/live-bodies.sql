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

CREATE OR REPLACE FUNCTION public._users_blocked(p_a uuid, p_b uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = p_a AND ub.blocked_id = p_b)
       OR (ub.blocker_id = p_b AND ub.blocked_id = p_a)
  )
$function$
;
