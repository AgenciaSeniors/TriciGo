-- 00482: promotions.first_ride_only — promos redeemable ONLY on the
-- customer's first completed ride.
--
-- IG-plan readiness review 2026-07-02 (Pubs 9/11 "primer viaje gratis"):
-- the only dedupe today is one-use-per-user (promotion_uses UNIQUE), valid
-- on ANY ride — a customer with 50 trips could redeem the launch promo on
-- trip 51. This adds an opt-in flag enforced in BOTH validation layers:
-- the UX RPC (validate_promo_code) and the server-authoritative trigger
-- (tg_rides_validate_promo_discount, anti-tamper layer of 00172/00320).
--
-- "First ride" = customer has NO completed ride yet at redemption time
-- (same signal trg_send_first_ride_email uses).

-- 1. Column (idempotent).
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS first_ride_only BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN promotions.first_ride_only IS
  '00482: when true, the code only validates for customers with zero completed rides.';

-- 2. validate_promo_code — body reproduced VERBATIM from live prod
--    (captured 2026-07-02 via pg_get_functiondef); only addition is the
--    first_ride_only gate (placed after the already_used check).
CREATE OR REPLACE FUNCTION public.validate_promo_code(p_code text, p_user_id uuid, p_fare_amount integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo RECORD;
  v_already_used BOOLEAN := false;
  v_discount INTEGER := 0;
  v_type TEXT;
  v_normalized TEXT := upper(trim(COALESCE(p_code, '')));
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'unauthenticated');
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'forbidden');
  END IF;

  IF length(v_normalized) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  SELECT * INTO v_promo
  FROM promotions
  WHERE upper(code) = v_normalized
    AND is_active = true
  LIMIT 1;

  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  IF v_promo.valid_from > NOW() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  IF v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'expired');
  END IF;

  IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'error', 'max_uses');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM promotion_uses
    WHERE promotion_id = v_promo.id AND user_id = p_user_id
  ) INTO v_already_used;

  IF v_already_used THEN
    RETURN jsonb_build_object('valid', false, 'error', 'already_used');
  END IF;

  -- 00482: first-ride-only gate.
  IF COALESCE(v_promo.first_ride_only, false) AND EXISTS (
    SELECT 1 FROM rides WHERE customer_id = p_user_id AND status = 'completed'
  ) THEN
    RETURN jsonb_build_object('valid', false, 'error', 'first_ride_only');
  END IF;

  v_type := v_promo.type::TEXT;
  IF v_type IN ('percentage_discount', 'bonus_credit') THEN
    v_discount := LEAST(
      ROUND(COALESCE(p_fare_amount, 0) * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      COALESCE(p_fare_amount, 0)
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      COALESCE(p_fare_amount, 0)
    );
  END IF;

  v_discount := GREATEST(v_discount, 0);

  RETURN jsonb_build_object(
    'valid', true,
    'promotion_id', v_promo.id,
    'code', v_promo.code,
    'type', v_type,
    'discount_amount', v_discount
  );
END;
$function$;

-- 3. tg_rides_validate_promo_discount — in-place patch (server-authoritative
--    layer). Extends the invalid-promo OR list so a first_ride_only promo on
--    a non-first ride behaves exactly like an inactive/expired one: promo
--    dropped, discount recomputed to shared-ride only.
DO $patch$
DECLARE
  v_src TEXT;
  v_anchor TEXT := 'OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())';
  v_add TEXT;
  v_count INTEGER;
BEGIN
  BEGIN
    SELECT pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure)
    INTO v_src;
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '00482: tg_rides_validate_promo_discount absent; skipping patch';
    RETURN;
  END;

  IF position('first_ride_only' IN v_src) > 0 THEN
    RAISE NOTICE '00482: trigger already patched; skipping';
    RETURN;
  END IF;

  v_count := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00482: anchor occurs % times (expected 1) — body drifted, patch aborted', v_count;
  END IF;

  v_add := v_anchor || chr(10) ||
    '     -- 00482: first-ride-only promos are invalid once the customer has a completed ride' || chr(10) ||
    '     OR (COALESCE(v_promo.first_ride_only, false) AND EXISTS (' || chr(10) ||
    '       SELECT 1 FROM rides r0 WHERE r0.customer_id = NEW.customer_id AND r0.status = ''completed''' || chr(10) ||
    '     ))';

  EXECUTE replace(v_src, v_anchor, v_add);
  RAISE NOTICE '00482: first_ride_only gate injected into tg_rides_validate_promo_discount';
END $patch$;
