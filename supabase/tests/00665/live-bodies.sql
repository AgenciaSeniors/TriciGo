-- LIVE bodies and EXECUTE grants read from prod on 2026-10-17 for the 00665 rehearsal.
-- Generated (plan 2026-10-17-signup-code-promotion, Task 1). Do not edit: run.sh S0 checks every md5.

CREATE OR REPLACE FUNCTION public._claim_reward(p_user_id uuid, p_claim text, p_ride_id uuid DEFAULT NULL::uuid, p_referral_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
  v_ok boolean;
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;

  INSERT INTO public.reward_claims (identity_hash, claim, user_id, ride_id, referral_id)
  VALUES (v_hash, p_claim, p_user_id, p_ride_id, p_referral_id)
  ON CONFLICT (identity_hash, claim) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         ride_id = EXCLUDED.ride_id,
         referral_id = EXCLUDED.referral_id,
         claimed_at = now(),
         released_at = NULL
   WHERE public.reward_claims.released_at IS NOT NULL
  RETURNING true INTO v_ok;

  RETURN CASE WHEN v_ok THEN 'claimed' ELSE 'taken' END;
END;
$function$;
REVOKE ALL ON FUNCTION public._claim_reward(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._claim_reward(uuid,text,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._reward_claim_status(p_user_id uuid, p_claim text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reward_claims c
              WHERE c.identity_hash = v_hash AND c.claim = p_claim AND c.released_at IS NULL) THEN
    RETURN 'taken';
  END IF;
  RETURN 'free';
END;
$function$;
REVOKE ALL ON FUNCTION public._reward_claim_status(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._reward_claim_status(uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public._reward_identity_hash(p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_digits text;
  v_salt text;
BEGIN
  SELECT regexp_replace(u.phone, '\D', '', 'g') INTO v_digits
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.phone_confirmed_at IS NOT NULL;
  IF v_digits IS NULL OR v_digits = '' THEN
    RETURN NULL;
  END IF;

  SELECT s.salt INTO v_salt FROM public.reward_identity_salt s WHERE s.id = 1;
  IF v_salt IS NULL OR v_salt = '' THEN
    RETURN NULL;
  END IF;

  RETURN encode(sha256(convert_to(v_salt || ':' || v_digits, 'UTF8')), 'hex');
END;
$function$;
REVOKE ALL ON FUNCTION public._reward_identity_hash(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._reward_identity_hash(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean, created_at timestamp with time zone, signups bigint, rider_signups bigint, driver_signups bigint, drivers_approved bigint, riders_with_ride bigint, drivers_with_ride bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed'))
  FROM public.acquisition_codes ac
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION public.get_platform_config_numeric(text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric(text,numeric) TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

CREATE OR REPLACE FUNCTION public.is_marketing()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
END;
$function$;
REVOKE ALL ON FUNCTION public.is_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO service_role;

CREATE OR REPLACE FUNCTION public.tg_rides_rollback_promo_on_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_use_existed BOOLEAN := false;
BEGIN
  IF NEW.promo_code_id IS NULL THEN
    RETURN NEW;
  END IF;

  DELETE FROM promotion_uses
  WHERE promotion_id = NEW.promo_code_id
    AND user_id = NEW.customer_id
    AND ride_id = NEW.id
  RETURNING true INTO v_use_existed;

  -- 00658: the phone's claim on this promo goes back too.
  UPDATE public.reward_claims SET released_at = now()
   WHERE claim = 'promo:' || NEW.promo_code_id::text AND ride_id = NEW.id AND released_at IS NULL;

  IF COALESCE(v_use_existed, false) THEN
    UPDATE promotions
    SET current_uses = GREATEST(current_uses - 1, 0)
    WHERE id = NEW.promo_code_id;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_rides_rollback_promo_on_cancel() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_rides_rollback_promo_on_cancel() TO service_role;

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
  -- 00631: a promo is claimed once, when the ride is created. A client may
  -- not attach, swap or drop it afterwards: every UPDATE applied the
  -- discount again without claiming a use. Admins and the service role
  -- still can (deleting a promotion sets it to NULL, see 00492 below).
  IF TG_OP = 'UPDATE'
     AND NEW.promo_code_id IS DISTINCT FROM OLD.promo_code_id
     AND auth.uid() IS NOT NULL
     AND NOT is_admin() THEN
    NEW.promo_code_id := OLD.promo_code_id;
  END IF;

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

  IF is_super_admin() AND COALESCE(current_setting('app.force_discount_recompute', true), '') <> '1' THEN
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
      -- 00658: each promo once per confirmed phone, not per account. No
      -- confirmed phone, or a phone that already used it (also from an
      -- account deleted since), drops the promo like a second use does.
      IF public._claim_reward(NEW.customer_id, 'promo:' || v_promo.id::text, NEW.id) <> 'claimed' THEN
        RAISE unique_violation;
      END IF;
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
      UPDATE public.reward_claims SET released_at = now()
       WHERE claim = 'promo:' || v_promo.id::text AND ride_id = NEW.id AND released_at IS NULL;
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

  -- 00631: a client's UPDATE may lower the promo part of the discount but
  -- never raise it. The promo was priced when the ride was created; a
  -- recompute on a grown base (a far stop's surcharge is in the snapshot
  -- total) applied the percentage to the stops too. A type change from
  -- support (app.force_discount_recompute, 00628), admins and the service
  -- role recompute freely.
  IF TG_OP = 'UPDATE'
     AND auth.uid() IS NOT NULL
     AND NOT is_admin()
     AND COALESCE(current_setting('app.force_discount_recompute', true), '') <> '1' THEN
    v_correct_discount := LEAST(v_correct_discount, GREATEST(
      COALESCE(OLD.discount_amount_cup, 0) - COALESCE(OLD.partner_discount_cup, 0)
        - COALESCE(OLD.shared_ride_discount_cup, 0), 0));
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
$function$;
REVOKE ALL ON FUNCTION public.tg_rides_validate_promo_discount() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_rides_validate_promo_discount() TO service_role;

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
$function$;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE OR REPLACE FUNCTION public.validate_promo_code(p_code text, p_user_id uuid, p_fare_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo RECORD;
  v_already_used BOOLEAN := false;
  v_claim TEXT;
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

  -- 00658: once per confirmed phone, from any account.
  v_claim := public._reward_claim_status(p_user_id, 'promo:' || v_promo.id::text);
  IF v_claim = 'no_phone' THEN
    RETURN jsonb_build_object('valid', false, 'error', 'phone_required');
  END IF;
  IF v_claim = 'taken' THEN
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
REVOKE ALL ON FUNCTION public.validate_promo_code(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_promo_code(text,uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_promo_code(text,uuid,integer) TO service_role;
