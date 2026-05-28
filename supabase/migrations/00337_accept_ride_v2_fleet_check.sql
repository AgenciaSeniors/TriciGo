-- ============================================================
-- Migration 00337: accept_ride_v2 — fleet membership validation
--                  (PR-CORP-4, closes Gap 3 from corporate audit)
--
-- Context: PR-CORP-3 (mig 00336) made `find_best_drivers` exclude
-- drivers outside the corp's fleet at DISPATCH time. But that's not
-- enough — if a driver received an offer via some other path
-- (cron retry with stale snapshot, future feature, manual ride
-- assignment), the `accept_ride_v2` RPC would still let them take
-- it. This migration adds the **second lock** so the corp fleet
-- guarantee is truly end-to-end.
--
-- Check: when the ride has `corporate_account_id IS NOT NULL` AND
-- the corp is `is_fleet_owner=true` AND has ≥1 active fleet_member
-- → driver MUST be in that fleet (via `fleet_members.driver_id =
-- v_driver.user_id` and `status='active'`). If not, return error
-- `not_in_fleet` with extra metadata so the frontend can surface a
-- clear toast.
--
-- Failure mode (intentional): if the fleet_owner corp has 0 active
-- members, the gate is silently dropped (so service doesn't break
-- for corps mid-setup). Mirrors the same defensive logic in
-- `find_best_drivers` from 00336.
--
-- Schema note: `fleet_members.driver_id` → `users.id` (NOT
-- `driver_profiles.id`). We use `v_driver.user_id` (from the
-- already-loaded driver_profiles row) to join.
--
-- Idempotent: CREATE OR REPLACE on the SAME signature.
-- ============================================================

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
  v_fleet_required         boolean := false;
  v_driver_in_fleet        boolean := false;
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

  -- 00337 — Fleet membership gate. Mirrors find_best_drivers (00336):
  -- only enforce when corp exists, is_fleet_owner=true, AND has ≥1
  -- active fleet_member. Defensive: if a fleet_owner has 0 members,
  -- restriction is silently dropped to avoid breaking service mid-setup.
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
          AND fm.driver_id = v_driver.user_id   -- ⚠️ fleet_members.driver_id → users.id
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
  v_base_fare        := GREATEST(v_raw_fare, v_svc_config.min_fare_cup);
  v_surge            := COALESCE(v_ride.surge_multiplier, 1.0);
  v_fare_after_surge := ROUND(v_base_fare * v_surge)::int;
  v_discount         := COALESCE(v_ride.discount_amount_cup, 0);
  v_estimated_fare_cup := GREATEST(v_fare_after_surge - v_discount, 0);
  v_estimated_fare_trc := v_estimated_fare_cup;

  -- BUG-concurrent-driver: wrap UPDATE to catch unique_violation from
  -- the rides_one_active_per_driver index.
  BEGIN
    UPDATE rides SET
      driver_id              = p_driver_id,
      status                 = 'accepted',
      accepted_at            = now(),
      estimated_fare_cup     = v_estimated_fare_cup,
      estimated_fare_trc     = v_estimated_fare_trc,
      driver_custom_rate_cup = v_custom_rate
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
      'estimated_fare_cup', v_estimated_fare_cup,
      'estimated_fare_trc', v_estimated_fare_trc
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

COMMENT ON FUNCTION public.accept_ride_v2(uuid, uuid) IS
  '00337: adds fleet membership gate for corporate rides. When ride.corporate_account_id is set AND corp is_fleet_owner=true AND has active fleet_members, driver MUST be in fleet_members (matched via user_id). Returns error=not_in_fleet otherwise. Defensive: silent passthrough if corp has 0 active members.';
