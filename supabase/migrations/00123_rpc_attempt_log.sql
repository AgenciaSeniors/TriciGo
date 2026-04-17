-- ============================================================
-- Migration 00123: rpc_attempt_log — observability for critical RPCs
--
-- Captures every accept_ride / cancel_ride attempt (successful or not)
-- so we can detect fraud patterns, driver app bugs, race-loss rates,
-- and unauthorized access attempts. Retention: 90 days.
-- ============================================================

CREATE TABLE IF NOT EXISTS rpc_attempt_log (
  id         bigserial PRIMARY KEY,
  rpc_name   text        NOT NULL,
  caller_uid uuid,
  target_id  uuid,
  outcome    text        NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rpc_attempt_log_rpc_created_idx
  ON rpc_attempt_log (rpc_name, created_at DESC);
CREATE INDEX IF NOT EXISTS rpc_attempt_log_caller_created_idx
  ON rpc_attempt_log (caller_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS rpc_attempt_log_outcome_idx
  ON rpc_attempt_log (outcome, created_at DESC)
  WHERE outcome <> 'success';

ALTER TABLE rpc_attempt_log ENABLE ROW LEVEL SECURITY;

-- Admin-only read; nobody writes directly (SECURITY DEFINER RPCs insert).
DROP POLICY IF EXISTS ral_admin_select ON rpc_attempt_log;
CREATE POLICY ral_admin_select ON rpc_attempt_log FOR SELECT
USING (is_admin());

REVOKE INSERT, UPDATE, DELETE ON rpc_attempt_log FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON rpc_attempt_log FROM anon;

-- Insert helper (invoked from inside other SECURITY DEFINER RPCs).
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(
  p_rpc_name   text,
  p_caller_uid uuid,
  p_target_id  uuid,
  p_outcome    text,
  p_metadata   jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  -- Fire-and-forget: logging must never break the caller.
  NULL;
END;
$$;

-- Retention: delete rows older than 90 days (pg_cron nightly).
DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'prune-rpc-attempt-log';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END
$$;

SELECT cron.schedule(
  'prune-rpc-attempt-log',
  '17 3 * * *',
  $$DELETE FROM rpc_attempt_log WHERE created_at < now() - interval '90 days';$$
);

-- ============================================================
-- Instrument accept_ride
-- ============================================================
CREATE OR REPLACE FUNCTION public.accept_ride(
  p_ride_id uuid,
  p_driver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ride            rides%ROWTYPE;
  v_driver          driver_profiles%ROWTYPE;
  v_existing_active rides%ROWTYPE;
  v_offer           ride_offers%ROWTYPE;
  v_caller_uid      uuid;
  v_log_meta        jsonb;
BEGIN
  v_caller_uid := auth.uid();
  v_log_meta := jsonb_build_object('driver_profile_id', p_driver_id);

  IF v_caller_uid IS NULL THEN
    PERFORM log_rpc_attempt('accept_ride', NULL, p_ride_id, 'unauthenticated', v_log_meta);
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = p_driver_id AND user_id = v_caller_uid
  ) THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'unauthorized', v_log_meta);
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'ride_not_found', v_log_meta);
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.driver_id = p_driver_id AND v_ride.status IN
     ('accepted','driver_en_route','arrived_at_pickup','in_progress') THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'idempotent', v_log_meta);
    RETURN jsonb_build_object('success',true,'ride_id',p_ride_id,'idempotent',true);
  END IF;

  IF v_ride.status <> 'searching' THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'ride_already_taken', v_log_meta || jsonb_build_object('current_status', v_ride.status));
    RETURN jsonb_build_object('error','ride_already_taken');
  END IF;

  SELECT * INTO v_offer FROM ride_offers
  WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_id
    AND status = 'pending' AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'offer_not_found_or_expired', v_log_meta);
    RETURN jsonb_build_object('error','offer_not_found_or_expired');
  END IF;

  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'driver_not_found', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_found');
  END IF;

  IF NOT v_driver.is_online THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'driver_not_online', v_log_meta);
    RETURN jsonb_build_object('error','driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL
     AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'driver_stale_heartbeat', v_log_meta);
    RETURN jsonb_build_object('error','driver_stale_heartbeat');
  END IF;

  SELECT * INTO v_existing_active FROM rides
  WHERE driver_id = p_driver_id
    AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    AND id <> p_ride_id
  LIMIT 1;

  IF FOUND THEN
    PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'driver_has_active_ride', v_log_meta || jsonb_build_object('active_ride_id', v_existing_active.id));
    RETURN jsonb_build_object('error','driver_has_active_ride','active_ride_id',v_existing_active.id);
  END IF;

  UPDATE rides SET
    driver_id = p_driver_id,
    status = 'accepted',
    accepted_at = now()
  WHERE id = p_ride_id AND status = 'searching';

  UPDATE ride_offers SET status = 'accepted', responded_at = now() WHERE id = v_offer.id;
  UPDATE ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND id <> v_offer.id AND status = 'pending';

  PERFORM log_rpc_attempt('accept_ride', v_caller_uid, p_ride_id, 'success', v_log_meta);
  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id);
END;
$$;

-- ============================================================
-- Instrument cancel_ride
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_ride(
  p_ride_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller_uid      uuid;
  v_ride            rides%ROWTYPE;
  v_is_customer     boolean := false;
  v_is_driver       boolean := false;
  v_canceled_by     uuid;
  v_fee             RECORD;
  v_penalty_amount  integer := 0;
  v_is_blocked      boolean := false;
  v_penalty         RECORD;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    PERFORM log_rpc_attempt('cancel_ride', NULL, p_ride_id, 'unauthenticated', NULL);
    RETURN jsonb_build_object('error','unauthenticated');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM log_rpc_attempt('cancel_ride', v_caller_uid, p_ride_id, 'ride_not_found', NULL);
    RETURN jsonb_build_object('error','ride_not_found');
  END IF;

  IF v_ride.status IN ('completed','canceled') THEN
    PERFORM log_rpc_attempt('cancel_ride', v_caller_uid, p_ride_id, 'ride_already_closed', jsonb_build_object('status', v_ride.status));
    RETURN jsonb_build_object('error','ride_already_closed','status',v_ride.status);
  END IF;

  v_is_customer := (v_ride.customer_id = v_caller_uid);
  IF v_ride.driver_id IS NOT NULL THEN
    v_is_driver := EXISTS (
      SELECT 1 FROM driver_profiles WHERE id = v_ride.driver_id AND user_id = v_caller_uid
    );
  END IF;

  IF NOT v_is_customer AND NOT v_is_driver THEN
    PERFORM log_rpc_attempt('cancel_ride', v_caller_uid, p_ride_id, 'unauthorized', NULL);
    RETURN jsonb_build_object('error','unauthorized');
  END IF;

  v_canceled_by := v_caller_uid;

  UPDATE rides SET
    status = 'canceled',
    canceled_at = now(),
    canceled_by = v_canceled_by,
    cancellation_reason = COALESCE(p_reason, cancellation_reason)
  WHERE id = p_ride_id;

  UPDATE ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';

  BEGIN
    SELECT * INTO v_fee FROM apply_cancellation_fee(p_ride_id, v_canceled_by);
  EXCEPTION WHEN OTHERS THEN
    v_fee := NULL;
  END;

  BEGIN
    SELECT * INTO v_penalty FROM apply_cancellation_penalty(v_canceled_by, p_ride_id);
    v_penalty_amount := COALESCE(v_penalty.penalty_amount, 0);
    v_is_blocked := COALESCE(v_penalty.is_blocked, false);
  EXCEPTION WHEN OTHERS THEN
    v_penalty_amount := 0;
    v_is_blocked := false;
  END;

  PERFORM log_rpc_attempt('cancel_ride', v_caller_uid, p_ride_id, 'success',
    jsonb_build_object(
      'canceled_role', CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
      'fee_cup', COALESCE(v_fee.fee_cup, 0),
      'fee_reason', COALESCE(v_fee.fee_reason, 'free_cancel'),
      'penalty_amount', v_penalty_amount,
      'is_blocked', v_is_blocked
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'canceled_by', v_canceled_by,
    'canceled_role', CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
    'fee_cup', COALESCE(v_fee.fee_cup, 0),
    'fee_trc', COALESCE(v_fee.fee_trc, 0),
    'fee_reason', COALESCE(v_fee.fee_reason, 'free_cancel'),
    'penalty_amount', v_penalty_amount,
    'is_blocked', v_is_blocked
  );
END;
$$;
