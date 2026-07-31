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
  -- Each byte is accepted with p = 248/256, so six characters take ~6.2 draws.
  -- 100 is unreachable in practice; it exists so that a degraded
  -- gen_random_bytes can never spin forever inside the transaction that
  -- completes a ride and moves money. A hang is not an exception, so no
  -- handler upstream could rescue it — the loop has to bound itself.
  c_max_draws CONSTANT INT := 100;
  v_code TEXT := '';
  v_byte INT;
  v_draws INT := 0;
BEGIN
  WHILE length(v_code) < 6 LOOP
    IF v_draws >= c_max_draws THEN
      RAISE EXCEPTION
        'coupon code generation exceeded % draws (only %/6 chars) — check pgcrypto',
        c_max_draws, length(v_code);
    END IF;
    v_draws := v_draws + 1;
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
  v_place         RECORD;
  v_code          TEXT;
  v_coupon_id     UUID;
  v_expires       TIMESTAMPTZ;
  v_attempts      INT;
  v_conflict_skip BOOLEAN;
  v_service_key   TEXT;
  v_headers       JSONB;
  v_key_warned    BOOLEAN := false;
BEGIN
  IF NEW.dropoff_location IS NULL OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Resolved once, not once per place: this is a vault lookup and a single
  -- dropoff can legitimately match several partner places.
  v_service_key := public.get_service_role_key();
  IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
    v_headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey',        v_service_key
    );
  END IF;

  -- Note: the radius comes from a column of partner_places, so PostGIS cannot
  -- fold this into an index qual and partner_places_location_gix does not
  -- serve it. Fine here — the table is small and admin-curated. See 00529.
  FOR v_place IN
    SELECT pp.*
    FROM public.partner_places pp
    WHERE pp.is_active
      AND (pp.valid_until IS NULL OR pp.valid_until > now())
      AND ST_DWithin(pp.location, NEW.dropoff_location, pp.radius_m)
  LOOP
    -- Frequency cap. cooldown_days = 0 (the shipped default) skips this
    -- entirely. Switching it on for a busy place would want an index on
    -- (partner_place_id, user_id, issued_at): partner_coupons_user_live_idx
    -- cannot serve this predicate because it is partial on
    -- redeemed_at IS NULL, and the cap deliberately counts redeemed coupons.
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
    v_conflict_skip := false;

    <<retry>>
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
        v_conflict_skip := (v_coupon_id IS NULL);
        EXIT retry WHEN v_coupon_id IS NULL;
      EXCEPTION WHEN unique_violation THEN
        -- Any UNIQUE on partner_coupons *other* than the one handled above.
        -- Today that is only partner_coupons_code_key — a code collision,
        -- which a fresh draw fixes. A unique constraint added later would
        -- also land here, and retrying could never satisfy it; that is what
        -- the warning below exists to surface.
        v_coupon_id := NULL;
      END;
    END LOOP;

    IF v_coupon_id IS NULL THEN
      -- Distinguish the benign case (this ride already had a coupon here)
      -- from five straight unique_violations, which at 31^6 is not chance.
      IF NOT v_conflict_skip THEN
        RAISE WARNING '[tg_rides_issue_partner_coupons] ride %: no coupon at place % after % unique_violation retries — check the RNG or an unexpected UNIQUE constraint',
          NEW.id, v_place.id, v_attempts;
      END IF;
      CONTINUE;
    END IF;

    IF v_service_key IS NULL OR v_service_key = '' THEN
      -- The coupon exists but the passenger will never hear about it. Say so
      -- once per ride rather than failing silently.
      IF NOT v_key_warned THEN
        RAISE WARNING '[tg_rides_issue_partner_coupons] ride %: service_role_key missing — coupon(s) issued but no push sent', NEW.id;
        v_key_warned := true;
      END IF;
      CONTINUE;
    END IF;

    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
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
-- Passenger rides only. In cargo (mensajería) customer_id is the SENDER and
-- the dropoff is the recipient's address — the sender never goes there, the
-- courier does. Issuing on cargo would tell someone "Llegaste a <place>" and
-- make the business absorb a perk for a person who never left home. Filtered
-- in the WHEN clause, the same fix and for the same reason as
-- trg_send_ride_receipt (00326).
CREATE TRIGGER trg_rides_issue_partner_coupons
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (
    NEW.status = 'completed'
    AND OLD.status IS DISTINCT FROM 'completed'
    AND NEW.ride_mode = 'passenger'
  )
  EXECUTE FUNCTION public.tg_rides_issue_partner_coupons();

COMMENT ON FUNCTION public._generate_coupon_code() IS
  '00530 Six-char coupon code over a 31-symbol alphabet (no 0/1/I/L/O), drawn from pgcrypto with rejection sampling so the distribution stays uniform.';
COMMENT ON FUNCTION public.tg_rides_issue_partner_coupons() IS
  '00530 Issues one partner coupon per matching place when a PASSENGER ride completes inside its radius (cargo excluded in the trigger WHEN clause). Never blocks the ride.';

-- Without this, _generate_coupon_code is reachable as
-- POST /rpc/_generate_coupon_code — a free oracle for the exact alphabet and
-- length, in a file whose whole premise is that the code should be costly to
-- guess. Neither function is meant to be called by anyone but the trigger.
--
-- `FROM PUBLIC` alone is NOT enough on this project and would be a silent
-- no-op: pg_default_acl carries
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role
-- (for both postgres and supabase_admin), so a new function is created with
-- *explicit* per-role grants and no PUBLIC grant at all. Verified: after
-- `REVOKE ... FROM PUBLIC` the ACL was still
-- {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,...} and
-- has_function_privilege('anon', ...) was still true. Naming the roles is the
-- house pattern (00282, 00283, 00439, 00496).
--
-- Safe for the trigger: PostgreSQL checks EXECUTE on a trigger function at
-- CREATE TRIGGER time, not on each firing, and the trigger body runs as its
-- SECURITY DEFINER owner. Verified below-the-line by completing a ride from an
-- `authenticated` session after the revoke — the coupon is still issued.
REVOKE ALL ON FUNCTION public._generate_coupon_code() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_rides_issue_partner_coupons() FROM PUBLIC, anon, authenticated;
