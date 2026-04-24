-- ============================================================
-- BUG-086: Driver wallet floor gate.
--
-- Rule: drivers cannot accept a ride if their driver_cash balance
-- is less than the estimated commission for that specific ride.
-- No grace period, no negative balance — the driver must always
-- hold at least the platform's cut in their wallet.
--
-- This complements the existing is_financially_eligible flag
-- (a broader, 24h-grace mechanism) by adding a strict per-ride
-- gate inside accept_ride_v2 itself.
-- ============================================================

-- 1) Helper: returns a diagnostic jsonb describing whether a driver
--    can afford the commission for a given CUP fare estimate.
CREATE OR REPLACE FUNCTION public.driver_can_afford_commission(
  p_driver_id uuid,
  p_estimated_fare_cup integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_user_id         uuid;
  v_balance_trc     integer;
  v_rate            numeric;
  v_commission_rate numeric;
  v_required_trc    integer;
BEGIN
  SELECT user_id INTO v_user_id FROM driver_profiles WHERE id = p_driver_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_not_found');
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance_trc
  FROM wallet_accounts
  WHERE user_id = v_user_id AND account_type = 'driver_cash';
  v_balance_trc := COALESCE(v_balance_trc, 0);

  v_rate := COALESCE(get_current_exchange_rate(), 520.0);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  -- Replicates complete_ride_and_pay's commission formula (in TRC centavos).
  v_required_trc := ROUND((COALESCE(p_estimated_fare_cup, 0)::numeric / v_rate) * 100 * v_commission_rate)::int;

  RETURN jsonb_build_object(
    'ok',              v_balance_trc >= v_required_trc,
    'balance_trc',     v_balance_trc,
    'required_trc',    v_required_trc,
    'commission_rate', v_commission_rate,
    'exchange_rate',   v_rate
  );
END;
$$;

COMMENT ON FUNCTION public.driver_can_afford_commission(uuid, integer) IS
  'Returns {ok, balance_trc, required_trc, ...}. Used as pre-accept gate so drivers cannot accept rides whose commission exceeds their driver_cash balance.';

-- 2) Rewrite accept_ride_v2 to run the gate AFTER all existing
--    checks but BEFORE the UPDATE. Preserves every existing branch.
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
  v_effective_per_km_rate  numeric;
  v_distance_km            numeric;
  v_duration_min           numeric;
  v_raw_fare               int;
  v_base_fare              int;
  v_surge                  numeric;
  v_fare_after_surge       int;
  v_discount               int;
  v_estimated_fare_cup     int;
  v_estimated_fare_trc     int;
  v_log_meta               jsonb;
  v_afford                 jsonb;
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

  IF NOT v_driver.is_online THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_online', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL
     AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_stale_heartbeat', v_log_meta);
    RETURN jsonb_build_object('error','driver_stale_heartbeat');
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

  SELECT base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup
    INTO v_svc_config
  FROM service_type_configs
  WHERE slug = v_ride.service_type AND is_active = true;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'service_config_missing', v_log_meta);
    RETURN jsonb_build_object('error','service_config_missing');
  END IF;

  v_custom_rate           := v_driver.custom_per_km_rate_cup;
  v_effective_per_km_rate := COALESCE(v_custom_rate, v_svc_config.per_km_rate_cup);
  v_distance_km           := COALESCE(v_ride.estimated_distance_m, 0)::numeric / 1000.0;
  v_duration_min          := COALESCE(v_ride.estimated_duration_s, 0)::numeric / 60.0;
  v_raw_fare := ROUND(
    v_svc_config.base_fare_cup
    + v_distance_km  * v_effective_per_km_rate
    + v_duration_min * v_svc_config.per_minute_rate_cup
  )::int;
  v_base_fare          := GREATEST(v_raw_fare, v_svc_config.min_fare_cup);
  v_surge              := COALESCE(v_ride.surge_multiplier, 1.0);
  v_fare_after_surge   := ROUND(v_base_fare * v_surge)::int;
  v_discount           := COALESCE(v_ride.discount_amount_cup, 0);
  v_estimated_fare_cup := GREATEST(v_fare_after_surge - v_discount, 0);
  v_estimated_fare_trc := v_estimated_fare_cup;

  -- ────────────────────────────────────────────────────────────
  -- NEW: Wallet floor gate (BUG-086). Reject the accept if the
  -- driver does not have enough driver_cash balance to cover the
  -- estimated commission for this ride. Same formula that
  -- complete_ride_and_pay will use at completion.
  -- ────────────────────────────────────────────────────────────
  v_afford := driver_can_afford_commission(p_driver_id, v_estimated_fare_cup);
  IF NOT (v_afford->>'ok')::boolean THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'insufficient_balance',
      v_log_meta || v_afford);
    RETURN jsonb_build_object(
      'error',           'insufficient_balance',
      'balance_trc',     (v_afford->>'balance_trc')::int,
      'required_trc',    (v_afford->>'required_trc')::int,
      'commission_rate', (v_afford->>'commission_rate')::numeric
    );
  END IF;

  UPDATE rides SET
    driver_id              = p_driver_id,
    status                 = 'accepted',
    accepted_at            = now(),
    estimated_fare_cup     = v_estimated_fare_cup,
    estimated_fare_trc     = v_estimated_fare_trc,
    driver_custom_rate_cup = v_custom_rate
  WHERE id = p_ride_id AND status = 'searching';

  UPDATE ride_offers SET status = 'accepted',   responded_at = now() WHERE id = v_offer.id;
  UPDATE ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND id <> v_offer.id AND status = 'pending';

  PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'success',
    v_log_meta || jsonb_build_object(
      'estimated_fare_cup', v_estimated_fare_cup,
      'estimated_fare_trc', v_estimated_fare_trc,
      'balance_trc',        (v_afford->>'balance_trc')::int,
      'required_trc',       (v_afford->>'required_trc')::int
    ));

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'estimated_fare_cup', v_estimated_fare_cup,
    'estimated_fare_trc', v_estimated_fare_trc,
    'driver_custom_rate_cup', v_custom_rate
  );
END;
$function$;
