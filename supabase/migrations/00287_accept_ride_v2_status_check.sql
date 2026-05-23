-- ============================================================
-- DRV-001 (security audit 2026-05-23, kill chain Driver fraud):
-- accept_ride_v2 NO valida driver_profiles.status='approved'.
--
-- The RPC checks driver ownership, is_online, last_heartbeat, single
-- active ride, and balance — but never asserts status='approved'.
-- Combined with the gap in tg_driver_profiles_protect_admin_fields
-- (DRV-002, fixed in 00288) where is_online is NOT in the lockdown
-- list, a driver in status='pending_verification' / 'rejected' /
-- 'under_review' / 'suspended' can:
--
--   1. supabase.from('driver_profiles').update({is_online: true})
--      → trg_dispatch_on_driver_online fires, sends offers
--   2. supabase.rpc('accept_ride_v2', {p_ride_id, p_driver_id})
--      → currently ACCEPTS — even though driver is unapproved
--
-- Effect: an attacker who completes basic onboarding (or who steals
-- a pending-driver account) can drive passengers without ever being
-- vetted: no admin review, no KYC verification confirmed, no
-- background check signed off. Real-world risk to rider safety +
-- legal liability to TriciGo.
--
-- Mitigating control today: the driver UI hides the "Ir Online"
-- toggle when status != 'approved'. But supabase-js calls bypass
-- the UI — defense in depth requires the RPC itself to reject.
--
-- Fix: add a status='approved' gate after the driver row is loaded,
-- before the existing is_online check. Logs to rpc_attempt_log with
-- the actual status for telemetry / dashboard.
--
-- Companion: migration 00288 closes the is_online toggle bypass in
-- the trigger, so an unapproved driver can't even reach the dispatch
-- loop. Both PRs together close the DRV-001/002 path.
-- ============================================================

CREATE OR REPLACE FUNCTION public.accept_ride_v2(
  p_ride_id   uuid,
  p_driver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
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
BEGIN
  v_caller_uid := auth.uid();
  v_log_meta   := jsonb_build_object('driver_profile_id', p_driver_id);

  IF v_caller_uid IS NULL THEN
    PERFORM log_rpc_attempt('accept_ride_v2', NULL, p_ride_id, 'unauthenticated', v_log_meta);
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  -- Verify driver ownership
  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = p_driver_id AND user_id = v_caller_uid
  ) THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'unauthorized', v_log_meta);
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  -- Lock the ride row (uses SECURITY DEFINER, bypasses RLS — safe because we
  -- just authorized via the offer/driver check below)
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'ride_not_found', v_log_meta);
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  -- Idempotency: same driver already accepted — return current fare snapshot
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

  -- Verify the driver has a valid pending offer (same check as v1)
  SELECT * INTO v_offer FROM ride_offers
  WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_id
    AND status = 'pending' AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'offer_not_found_or_expired', v_log_meta);
    RETURN jsonb_build_object('error','offer_not_found_or_expired');
  END IF;

  -- Load driver profile for eligibility + custom rate
  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride_v2', v_caller_uid, p_ride_id, 'driver_not_found', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_found');
  END IF;

  -- DRV-001: driver must be approved. status enum includes
  -- 'pending_verification', 'under_review', 'approved', 'rejected',
  -- 'suspended'. Only 'approved' may accept rides. Logged with the
  -- actual status so dashboards can flag unapproved drivers attempting
  -- to dispatch (potential indicator of credential compromise or
  -- abuse of the dp_update_own RLS gap on is_online — see 00288).
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

  -- Enforce single active ride per driver
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

  -- Fare calculation — mirrors driver.service.ts:acceptRide lines 346-369
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
  -- CUP/TRC is 1:1 per packages/utils/src/currency.ts:cupToTrcCentavos (deprecated helper)
  v_estimated_fare_trc := v_estimated_fare_cup;

  -- Atomic mutation: ride status + fare + offer updates in single txn
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
$$;

COMMENT ON FUNCTION public.accept_ride_v2(uuid, uuid) IS
  'DRV-001: rejects unapproved drivers (status != ''approved'') in addition to the existing is_online / heartbeat / single-active-ride / ownership checks. Returns {error: ''driver_not_approved'', driver_status: <actual>} so dashboards can flag attempted abuse.';
