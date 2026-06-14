-- 00427_anonymize_old_rides_fix_and_otp_throttle.sql
-- ============================================================================
-- Two P3 hardening fixes from the round-3 audit (2026-06-14).
--
-- CRON-03: anonymize_old_rides (yearly GDPR/data-retention cron, jobid 31) errors
--   on EVERY run — it references columns/enum labels that don't exist:
--     * SET cancel_reason = NULL          → 42703 (real column is cancellation_reason)
--     * SET special_instructions = NULL   → 42703 (no such column on rides)
--     * status IN ('cancelled','expired') → 22P02 (invalid ride_status; the label
--                                            is 'canceled' and there is no 'expired')
--   So the function aborts before touching a row and the 730-day PII-scrub promise
--   (docs/DATA_RETENTION_POLICY.md) is silently never fulfilled.
--   Fix: real column (cancellation_reason), drop the non-existent ones, valid
--   status labels ('completed','canceled','disputed'), and — because
--   rides.customer_id is NOT NULL — re-point it to the anon user (the established
--   anonymize_user_references pattern) instead of NULL; driver_id IS nullable so
--   it is NULLed. Idempotency guard updated to match.
--
-- NMC-02: validate_delivery_otp has no throttle on a 4-digit (10000-combo) OTP, so
--   the ride's assigned driver can script ~10000 calls to brute-force the
--   recipient's delivery code and stamp delivery_otp_validated_at (unlocking the
--   +5% cargo bonus) without the recipient ever providing it.
--   Fix: throttle attempts per ride via the existing check_rate_limit (5 / 10 min);
--   fail-open on a limiter error (never block a legitimate delivery).
-- ============================================================================

-- CRON-03: fix the GDPR ride-anonymization function.
CREATE OR REPLACE FUNCTION public.anonymize_old_rides()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_updated bigint;
  v_anon_id CONSTANT uuid := '00000000-0000-0000-0000-000000000099';
  v_threshold timestamptz := now() - interval '730 days';
BEGIN
  WITH upd AS (
    UPDATE public.rides SET
      customer_id         = v_anon_id,   -- NOT NULL → re-point to the anon user
      driver_id           = NULL,
      pickup_address      = 'ANONYMIZED',
      dropoff_address     = 'ANONYMIZED',
      cancellation_reason = NULL,
      share_token         = NULL
    WHERE created_at < v_threshold
      AND status IN ('completed', 'canceled', 'disputed')
      AND (customer_id <> v_anon_id OR pickup_address <> 'ANONYMIZED')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RETURN jsonb_build_object(
    'anonymized_rows', v_updated,
    'threshold_date', v_threshold,
    'ran_at', now()
  );
END;
$function$;

-- NMC-02: throttle delivery-OTP validation attempts (body verbatim + the throttle).
CREATE OR REPLACE FUNCTION public.validate_delivery_otp(p_ride_id uuid, p_otp text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_stored_otp text; v_driver_user uuid; v_allowed boolean;
BEGIN
  SELECT dd.delivery_otp, dp.user_id INTO v_stored_otp, v_driver_user
  FROM rides r
  LEFT JOIN delivery_details dd ON dd.ride_id = r.id
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id AND r.ride_mode = 'cargo' LIMIT 1;

  IF v_driver_user IS NULL OR v_driver_user <> auth.uid() THEN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin','super_admin')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'forbidden');
    END IF;
  END IF;

  -- NMC-02: throttle brute-force on the 4-digit OTP (10000-combo space).
  -- 5 attempts / 10 min per ride; fail-open on a limiter error so a legitimate
  -- delivery is never blocked.
  SELECT allowed INTO v_allowed FROM check_rate_limit('delivery_otp:' || p_ride_id::text, 5, 600);
  IF NOT COALESCE(v_allowed, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'too_many_attempts');
  END IF;

  IF v_stored_otp IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'no_otp_set'); END IF;
  IF v_stored_otp <> p_otp THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_otp'); END IF;

  UPDATE delivery_details SET delivery_otp_validated_at = NOW() WHERE ride_id = p_ride_id;
  RETURN jsonb_build_object('success', true);
END;
$function$;
