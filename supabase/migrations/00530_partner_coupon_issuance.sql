-- 00530_partner_coupon_issuance.sql
-- Issues a coupon when a ride completes inside a partner place's radius.

-- Six characters from a 31-symbol alphabet with 0/1/I/L/O removed, because
-- the code is read aloud across a noisy counter. 31^6 ≈ 887M — six rather
-- than four specifically because the validation page is public and a short
-- code invites brute-forcing other people's coupons into the "used" state.
--
-- Uses pgcrypto (schema `extensions`), not random(): a predictable PRNG is
-- exactly the weakness that makes a public redeem endpoint attackable.
-- Rejection sampling above 248 keeps the distribution uniform (248 = 31*8).
CREATE OR REPLACE FUNCTION public._generate_coupon_code()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  c_alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code TEXT := '';
  v_byte INT;
BEGIN
  WHILE length(v_code) < 6 LOOP
    v_byte := get_byte(extensions.gen_random_bytes(1), 0);
    IF v_byte < 248 THEN
      v_code := v_code || substr(c_alphabet, (v_byte % 31) + 1, 1);
    END IF;
  END LOOP;
  RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_rides_issue_partner_coupons()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_place       RECORD;
  v_code        TEXT;
  v_coupon_id   UUID;
  v_expires     TIMESTAMPTZ;
  v_attempts    INT;
  v_service_key TEXT;
BEGIN
  IF NEW.dropoff_location IS NULL OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_place IN
    SELECT pp.*
    FROM public.partner_places pp
    WHERE pp.is_active
      AND (pp.valid_until IS NULL OR pp.valid_until > now())
      AND ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)
  LOOP
    -- Frequency cap. cooldown_days = 0 (the shipped default) skips this.
    IF v_place.cooldown_days > 0 AND EXISTS (
      SELECT 1 FROM public.partner_coupons pc
      WHERE pc.partner_place_id = v_place.id
        AND pc.user_id = NEW.customer_id
        AND pc.issued_at > now() - make_interval(days => v_place.cooldown_days)
    ) THEN
      CONTINUE;
    END IF;

    -- Deduplication, NOT a frequency cap: while a live unredeemed coupon
    -- exists for this place, don't mint a second one. Two valid codes for
    -- one free coffee is what the business does not want at the counter.
    -- Once it is redeemed or expires, the next qualifying ride issues again.
    IF EXISTS (
      SELECT 1 FROM public.partner_coupons pc
      WHERE pc.partner_place_id = v_place.id
        AND pc.user_id = NEW.customer_id
        AND pc.redeemed_at IS NULL
        AND pc.expires_at > now()
    ) THEN
      CONTINUE;
    END IF;

    v_expires := now() + make_interval(mins => v_place.coupon_ttl_minutes);
    v_coupon_id := NULL;
    v_attempts := 0;

    WHILE v_coupon_id IS NULL AND v_attempts < 5 LOOP
      v_attempts := v_attempts + 1;
      v_code := public._generate_coupon_code();
      BEGIN
        INSERT INTO public.partner_coupons
          (partner_place_id, user_id, ride_id, code, expires_at)
        VALUES (v_place.id, NEW.customer_id, NEW.id, v_code, v_expires)
        ON CONFLICT ON CONSTRAINT partner_coupons_ride_place_uniq DO NOTHING
        RETURNING id INTO v_coupon_id;
        -- DO NOTHING fired: this ride already has a coupon for this place
        -- (the ride re-entered 'completed'). Nothing to do, and no retry.
        EXIT WHEN v_coupon_id IS NULL;
      EXCEPTION WHEN unique_violation THEN
        -- Code collision only. Loop and draw another.
        v_coupon_id := NULL;
      END;
    END LOOP;

    IF v_coupon_id IS NULL THEN
      CONTINUE;
    END IF;

    v_service_key := public.get_service_role_key();
    IF v_service_key IS NULL OR v_service_key = '' THEN
      CONTINUE;
    END IF;

    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey',        v_service_key
      ),
      body := jsonb_build_object(
        'user_id',  NEW.customer_id::text,
        'title',    'Llegaste a ' || v_place.name,
        'body',     v_place.benefit_title || '. Muestra tu cupón antes de las '
                    || to_char(v_expires AT TIME ZONE 'America/Havana', 'HH24:MI') || '.',
        'category', 'partner_coupon',
        'data', jsonb_build_object(
          'type',       'partner_coupon',
          'coupon_id',  v_coupon_id::text,
          'place_name', v_place.name,
          'expires_at', v_expires
        )
      )
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A marketing perk must NEVER block the completion or payment of a ride.
  RAISE WARNING '[tg_rides_issue_partner_coupons] ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rides_issue_partner_coupons ON public.rides;
CREATE TRIGGER trg_rides_issue_partner_coupons
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.tg_rides_issue_partner_coupons();
