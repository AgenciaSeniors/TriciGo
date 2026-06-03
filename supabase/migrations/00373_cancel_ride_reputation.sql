-- ============================================================
-- Cancellation reputation (Phase 2/3) — rewrite cancel_ride() to
-- punish late cancellations with a RATING hit instead of money.
--
-- What changes vs the live version (00121):
--   * NO money. apply_cancellation_fee / apply_cancellation_penalty
--     are no longer called (they are decommissioned below).
--   * A "late" cancellation inserts a cancellation_rating_events row
--     (00372). Eligibility is symmetric for rider & driver: the ride
--     was in an active state (a driver was engaged) AND outside the
--     per-service free_cancel_window_s grace window.
--   * Progressive in stars, mirroring the old money progression:
--       1st late cancel / 24h  → grace  (rating_value NULL, no hit)
--       2nd                    → cancel_rating_value_second (3.0)
--       3rd+                   → cancel_rating_value_third  (2.0)
--   * Returns the rating impact (stars_before/after, is_grace, …).
--     Legacy money fields are still present but always 0 so old
--     clients don't break.
--
-- Also (re)defines preview_cancellation_rating_impact() so the UI can
-- show "your rating will drop ★X → ★Y" before confirming.
-- ============================================================

-- 1. cancel_ride — reputation model -----------------------------
CREATE OR REPLACE FUNCTION public.cancel_ride(p_ride_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid      uuid;
  v_ride            rides%ROWTYPE;
  v_is_customer     boolean := false;
  v_is_driver       boolean := false;
  v_canceled_by     uuid;
  v_window_s        integer := 120;
  v_active          boolean := false;
  v_within_grace    boolean := false;
  v_eligible        boolean := false;
  v_count_24h       integer := 0;
  v_rating_value    numeric := NULL;
  v_is_grace        boolean := true;
  v_stars_before    numeric := NULL;
  v_stars_after     numeric := NULL;
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

  -- ── Reputation eligibility (symmetric rider/driver) ──────────
  -- A "late" cancellation = the ride was in an active state (a driver
  -- was engaged) AND we're past the per-service grace window. A ride
  -- still 'searching' (no driver) is always grace.
  SELECT COALESCE(free_cancel_window_s, 120) INTO v_window_s
    FROM cancellation_fee_configs
   WHERE service_type = v_ride.service_type AND is_active = true;
  IF v_window_s IS NULL THEN v_window_s := 120; END IF;

  v_active := v_ride.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress');
  v_within_grace := (v_ride.accepted_at IS NOT NULL
                     AND EXTRACT(EPOCH FROM (now() - v_ride.accepted_at)) <= v_window_s);
  -- A driver cancelling for passenger no-show is NOT penalized — the rider
  -- failed to show, not the driver. (Penalizing the no-show rider instead
  -- is a future enhancement: it needs server-side no-show proof to avoid
  -- abuse, so for now a no-show simply costs no one their rating.)
  v_eligible := v_active AND NOT v_within_grace
                AND NOT (v_is_driver AND COALESCE(p_reason, '') ILIKE '%no_show%');

  -- stars before (read the canceller's current visible rating)
  IF v_is_driver THEN
    SELECT rating_avg INTO v_stars_before FROM driver_profiles WHERE user_id = v_canceled_by;
  ELSE
    SELECT rating_avg INTO v_stars_before FROM customer_profiles WHERE user_id = v_canceled_by;
  END IF;
  v_stars_after := v_stars_before;

  IF v_eligible THEN
    -- progressive: count this user's late cancels in the rolling 24h
    SELECT COUNT(*) INTO v_count_24h
      FROM cancellation_rating_events
     WHERE user_id = v_canceled_by
       AND created_at > now() - INTERVAL '24 hours';

    v_rating_value := CASE
      WHEN v_count_24h = 0 THEN NULL  -- 1st late cancel/24h: grace
      WHEN v_count_24h = 1 THEN get_platform_config_numeric('cancel_rating_value_second', 3.0)
      ELSE                        get_platform_config_numeric('cancel_rating_value_third', 2.0)
    END;
    v_is_grace := (v_rating_value IS NULL);

    INSERT INTO cancellation_rating_events (user_id, ride_id, rating_value, role_at_event, reason)
    VALUES (
      v_canceled_by, p_ride_id, v_rating_value,
      CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
      COALESCE(p_reason, 'late_cancellation')
    )
    ON CONFLICT (user_id, ride_id) WHERE ride_id IS NOT NULL DO NOTHING;

    -- preserve the legacy lifetime counter (analytics still read it)
    UPDATE users
       SET cancellation_count = COALESCE(cancellation_count, 0) + 1,
           last_cancellation_at = now()
     WHERE id = v_canceled_by;

    -- the AFTER INSERT trigger already recomputed rating_avg; read it
    IF v_is_driver THEN
      SELECT rating_avg INTO v_stars_after FROM driver_profiles WHERE user_id = v_canceled_by;
    ELSE
      SELECT rating_avg INTO v_stars_after FROM customer_profiles WHERE user_id = v_canceled_by;
    END IF;
  ELSE
    v_is_grace := true;
  END IF;

  PERFORM log_rpc_attempt('cancel_ride', v_caller_uid, p_ride_id, 'success',
    jsonb_build_object(
      'canceled_role', CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
      'eligible', v_eligible,
      'is_grace', v_is_grace,
      'rating_value', v_rating_value,
      'cancel_count_24h', v_count_24h,
      'stars_before', v_stars_before,
      'stars_after', v_stars_after
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'ride_id', p_ride_id,
    'canceled_by', v_canceled_by,
    'canceled_role', CASE WHEN v_is_customer THEN 'customer' ELSE 'driver' END,
    -- legacy money fields kept at 0 for backward-compatible clients
    'fee_cup', 0,
    'fee_trc', 0,
    'fee_reason', CASE WHEN v_eligible AND NOT v_is_grace THEN 'rating_penalty' ELSE 'free_cancel' END,
    'penalty_amount', 0,
    'is_blocked', false,
    -- new reputation fields
    'rating_penalized', (v_eligible AND v_rating_value IS NOT NULL),
    'is_grace', v_is_grace,
    'cancel_count_24h', v_count_24h,
    'rating_value', v_rating_value,
    'stars_before', v_stars_before,
    'stars_after', v_stars_after
  );
END;
$function$;

-- 2. preview_cancellation_rating_impact -------------------------
-- Read-only projection of what cancelling NOW would do to the caller's
-- visible rating. Mirrors cancel_ride's eligibility + progression.
CREATE OR REPLACE FUNCTION public.preview_cancellation_rating_impact(p_ride_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid   uuid := auth.uid();
  v_ride         rides%ROWTYPE;
  v_is_customer  boolean := false;
  v_is_driver    boolean := false;
  v_window_s     integer := 120;
  v_active       boolean := false;
  v_within_grace boolean := false;
  v_eligible     boolean := false;
  v_count_24h    integer := 0;
  v_rating_value numeric := NULL;
  v_is_grace     boolean := true;
  v_stars_before numeric := NULL;
  v_stars_after  numeric := NULL;
  v_window_days  numeric := get_platform_config_numeric('cancel_rating_event_window_days', 90);
  v_sum numeric; v_cnt numeric;
BEGIN
  IF v_caller_uid IS NULL THEN RETURN jsonb_build_object('error','unauthenticated'); END IF;
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;

  v_is_customer := (v_ride.customer_id = v_caller_uid);
  IF v_ride.driver_id IS NOT NULL THEN
    v_is_driver := EXISTS (SELECT 1 FROM driver_profiles WHERE id = v_ride.driver_id AND user_id = v_caller_uid);
  END IF;

  SELECT COALESCE(free_cancel_window_s, 120) INTO v_window_s
    FROM cancellation_fee_configs WHERE service_type = v_ride.service_type AND is_active = true;
  IF v_window_s IS NULL THEN v_window_s := 120; END IF;

  v_active := v_ride.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress');
  v_within_grace := (v_ride.accepted_at IS NOT NULL
                     AND EXTRACT(EPOCH FROM (now() - v_ride.accepted_at)) <= v_window_s);
  v_eligible := v_active AND NOT v_within_grace;

  IF v_is_driver THEN
    SELECT rating_avg INTO v_stars_before FROM driver_profiles WHERE user_id = v_caller_uid;
  ELSE
    SELECT rating_avg INTO v_stars_before FROM customer_profiles WHERE user_id = v_caller_uid;
  END IF;
  v_stars_after := v_stars_before;

  IF v_eligible THEN
    SELECT COUNT(*) INTO v_count_24h
      FROM cancellation_rating_events
     WHERE user_id = v_caller_uid AND created_at > now() - INTERVAL '24 hours';
    v_rating_value := CASE
      WHEN v_count_24h = 0 THEN NULL
      WHEN v_count_24h = 1 THEN get_platform_config_numeric('cancel_rating_value_second', 3.0)
      ELSE                        get_platform_config_numeric('cancel_rating_value_third', 2.0)
    END;
    v_is_grace := (v_rating_value IS NULL);

    IF v_rating_value IS NOT NULL THEN
      -- estimate the post-cancel average without writing
      SELECT COALESCE(SUM(s.val),0), COUNT(s.val) INTO v_sum, v_cnt
      FROM (
        SELECT r.rating::numeric AS val FROM reviews r
          WHERE r.reviewee_id = v_caller_uid AND r.is_visible = true
        UNION ALL
        SELECT ce.rating_value FROM cancellation_rating_events ce
          WHERE ce.user_id = v_caller_uid AND ce.rating_value IS NOT NULL
            AND (v_window_days <= 0 OR ce.created_at > now() - (v_window_days || ' days')::interval)
      ) s;
      v_stars_after := GREATEST(1.00, LEAST(5.00,
        ROUND((v_sum + v_rating_value) / (v_cnt + 1), 2)));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'eligible', v_eligible,
    'is_grace', v_is_grace,
    'rating_penalized', (v_eligible AND v_rating_value IS NOT NULL),
    'cancel_count_24h', v_count_24h,
    'rating_value', v_rating_value,
    'stars_before', v_stars_before,
    'stars_after', v_stars_after
  );
END;
$function$;

-- 3. Decommission the money RPCs (kept, not dropped) ------------
COMMENT ON FUNCTION public.apply_cancellation_fee(uuid, uuid) IS
  '00373 DEPRECATED: cancellation no longer charges money. No longer called by cancel_ride. Kept for historical reference; safe to drop once confirmed zero callers.';
COMMENT ON FUNCTION public.apply_cancellation_penalty(uuid, uuid) IS
  '00373 DEPRECATED: cancellation no longer charges money. Replaced by cancellation_rating_events. Kept for historical reference; safe to drop once confirmed zero callers.';
COMMENT ON FUNCTION public.preview_cancellation_penalty(uuid) IS
  '00373 DEPRECATED: use preview_cancellation_rating_impact(ride_id). Kept for backward-compatible clients.';
