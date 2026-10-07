-- Scaffold for the 00631 rehearsal: the tables and columns that the four
-- patched functions read, with the LIVE bodies of those functions read from
-- prod on 2026-10-07 (tg_rides_validate_estimated_fare,
-- tg_rides_validate_promo_discount as patched by 00628, trg_referral_reward_on_complete,
-- admin_send_gift), their LIVE trigger definitions, and the LIVE bodies of
-- auth.uid(), current_user_role(), is_admin() (00592), is_super_admin(),
-- get_platform_config_numeric(), _gift_wallet_type(), get_current_exchange_rate(),
-- cup_to_trc_centavos() and apply_referral_code(). referrals carries prod's
-- columns, constraints, policies and grants.
-- Simplified on purpose: ensure_wallet_account() (find or create the row) and
-- the estimate snapshot trigger (prod's also stores rates and commission; the
-- contract tested here is total = estimated_fare_cup). PostGIS lives in public,
-- as in prod. A NON-superuser role (prod: postgres) owns everything; run.sh
-- applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold',
  'platform_revenue', 'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin',
  'platform_fx_reserve');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.referral_status AS ENUM ('pending', 'rewarded', 'invalidated');

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
$function$
;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

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
$function$
;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

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
$function$
;

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
$function$
;

CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.exchange_rates (usd_cup_rate numeric, is_current boolean, fetched_at timestamptz);

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
$function$
;

CREATE OR REPLACE FUNCTION public.get_current_exchange_rate()
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_rate NUMERIC;
BEGIN
  SELECT usd_cup_rate INTO v_rate FROM exchange_rates WHERE is_current = true LIMIT 1;
  IF v_rate IS NULL THEN
    SELECT usd_cup_rate INTO v_rate FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1;
  END IF;
  IF v_rate IS NULL THEN
    SELECT (value #>> '{}')::NUMERIC INTO v_rate FROM platform_config WHERE key = 'exchange_rate_fallback_cup';
    v_rate := COALESCE(v_rate, 640.0);
  END IF;
  RETURN v_rate;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cup_to_trc_centavos(p_cup_pesos numeric, p_exchange_rate numeric)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- Rebase 00094: 1 TRC = 1 CUP (sin centavos). Devolver el CUP tal cual.
  -- p_exchange_rate se ignora (se conserva por compatibilidad de firma).
  RETURN ROUND(p_cup_pesos);
END;
$function$
;

CREATE OR REPLACE FUNCTION public._gift_wallet_type(p_user_id uuid)
 RETURNS wallet_account_type
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE WHEN u.role = 'driver' THEN 'tricicoin'::wallet_account_type
              ELSE 'customer_cash'::wallet_account_type END
  FROM users u WHERE u.id = p_user_id;
$function$
;

-- Wallets and ledger: only what the gift and the referral bonus write.
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  updated_at timestamptz,
  UNIQUE (user_id, account_type)
);
CREATE TABLE public.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  type text, status text, reference_type text, reference_id uuid,
  description text, metadata jsonb, created_by uuid
);
CREATE TABLE public.ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid REFERENCES public.ledger_transactions(id),
  account_id uuid REFERENCES public.wallet_accounts(id),
  amount integer, balance_after integer
);
CREATE TABLE public.wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid, to_user_id uuid, amount integer, note text, transaction_id uuid, kind text
);
CREATE TABLE public.admin_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid, action text, target_type text, target_id text, reason text
);

-- Simplified: find or create the row (prod also guards direct client calls, 00591).
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type wallet_account_type)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type) VALUES (p_user_id, p_type) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.ensure_wallet_account(uuid, wallet_account_type) FROM PUBLIC, anon, authenticated;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id)
);

-- Pricing: the columns the ceiling reads.
CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  max_passengers integer NOT NULL DEFAULT 4,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text NOT NULL,
  base_fare_cup integer NOT NULL,
  per_km_rate_cup integer NOT NULL,
  per_minute_rate_cup integer NOT NULL,
  min_fare_cup integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text,
  type text NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now() - interval '1 day',
  valid_until timestamptz,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  first_ride_only boolean NOT NULL DEFAULT false
);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, commission_percent numeric);
CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  location geography(Point, 4326) NOT NULL,
  radius_m integer NOT NULL,
  discount_percent numeric NOT NULL
);
CREATE TABLE public.admin_promo_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid, ride_id uuid, customer_id uuid, promo_code_id uuid,
  discount_amount_cup_supplied integer, estimated_fare_cup integer, notes text
);

-- rides: the columns the four triggers read, prod's service_type FK and
-- promo_code_id ON DELETE SET NULL (00492). RLS: simplified own-row policies.
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  service_type text NOT NULL REFERENCES public.service_type_configs(slug),
  ride_mode text NOT NULL DEFAULT 'passenger',
  pickup_location geography(Point, 4326) NOT NULL,
  dropoff_location geography(Point, 4326) NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0 CHECK (estimated_fare_cup >= 0),
  surge_multiplier numeric NOT NULL DEFAULT 1,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  discount_amount_cup integer NOT NULL DEFAULT 0,
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  corporate_account_id uuid
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.rides TO authenticated;
GRANT ALL ON public.rides TO service_role;
CREATE POLICY rides_insert_own ON public.rides FOR INSERT WITH CHECK (customer_id = auth.uid());
CREATE POLICY rides_select_own ON public.rides FOR SELECT USING (customer_id = auth.uid() OR is_admin());
CREATE POLICY rides_update_own ON public.rides FOR UPDATE USING (customer_id = auth.uid() OR is_admin());

CREATE TABLE public.ride_pricing_snapshots (
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type text NOT NULL,
  total integer,
  pre_waypoints_total integer,
  surge_multiplier numeric,
  UNIQUE (ride_id, snapshot_type)
);
ALTER TABLE public.ride_pricing_snapshots ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.promotion_uses (
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ride_id uuid,
  UNIQUE (promotion_id, user_id)
);

-- referrals: LIVE columns, constraints, policies and grants.
CREATE TABLE public.referral_codes (user_id uuid PRIMARY KEY REFERENCES public.users(id), code text UNIQUE NOT NULL);
CREATE TABLE public.referrals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL,
  referee_id uuid NOT NULL,
  code text NOT NULL,
  status public.referral_status NOT NULL DEFAULT 'pending'::referral_status,
  bonus_amount integer NOT NULL DEFAULT 500,
  transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz,
  CONSTRAINT referrals_pkey PRIMARY KEY (id),
  CONSTRAINT referrals_bonus_positive CHECK ((bonus_amount > 0)),
  CONSTRAINT referrals_bonus_sane CHECK ((bonus_amount <= 100000)),
  CONSTRAINT referrals_no_self_referral CHECK ((referrer_id <> referee_id)),
  CONSTRAINT referrals_referee_id_fkey FOREIGN KEY (referee_id) REFERENCES public.users(id),
  CONSTRAINT referrals_referee_id_key UNIQUE (referee_id),
  CONSTRAINT referrals_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES public.users(id),
  CONSTRAINT referrals_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id)
);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referrals TO anon, authenticated, service_role;
CREATE POLICY ref_insert ON public.referrals FOR INSERT WITH CHECK ((referee_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY ref_select ON public.referrals FOR SELECT USING (((referrer_id = ( SELECT auth.uid() AS uid)) OR (referee_id = ( SELECT auth.uid() AS uid)) OR is_admin()));

CREATE OR REPLACE FUNCTION public.apply_referral_code(p_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_referee_id UUID := auth.uid();
  v_referrer_id UUID;
  v_referrer_active BOOLEAN;
  v_normalized_code TEXT;
  v_referral_id UUID;
  v_bonus_cup INTEGER;
BEGIN
  IF v_referee_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  v_normalized_code := upper(trim(p_code));

  SELECT rc.user_id, u.is_active
    INTO v_referrer_id, v_referrer_active
  FROM referral_codes rc
  JOIN users u ON u.id = rc.user_id
  WHERE rc.code = v_normalized_code;

  IF v_referrer_id IS NULL THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  IF NOT COALESCE(v_referrer_active, false) THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  IF v_referrer_id = v_referee_id THEN
    RAISE EXCEPTION 'No puedes usar tu propio codigo' USING ERRCODE = 'P0002';
  END IF;

  -- 00395: admin-configurable bonus (defaults to 500 CUP if the key is absent).
  v_bonus_cup := GREATEST(COALESCE(get_platform_config_numeric('referral_bonus_cup', 500), 500)::INTEGER, 0);

  BEGIN
    INSERT INTO referrals (referrer_id, referee_id, code, status, bonus_amount)
    VALUES (v_referrer_id, v_referee_id, v_normalized_code, 'pending', v_bonus_cup)
    RETURNING id INTO v_referral_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya usaste un codigo de referido' USING ERRCODE = 'P0003';
  END;

  RETURN v_referral_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.apply_referral_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_referral_code(text) TO authenticated, service_role;

-- Simplified estimate snapshot (prod: tg_rides_create_estimate_snapshot): the
-- contract is total = the estimated fare the insert left.
CREATE OR REPLACE FUNCTION public.tg_rides_create_estimate_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO ride_pricing_snapshots (ride_id, snapshot_type, total, surge_multiplier)
  VALUES (NEW.id, 'estimate', NEW.estimated_fare_cup, NEW.surge_multiplier)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$
;

-- ===== LIVE bodies of the four functions 00631 changes =====

CREATE OR REPLACE FUNCTION public.tg_rides_validate_estimated_fare()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_min integer;
BEGIN
  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT min_fare_cup INTO v_min
  FROM service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF v_min IS NULL THEN
    SELECT MIN(min_fare_cup) INTO v_min
    FROM pricing_rules
    WHERE service_type = NEW.service_type AND is_active = true;
  END IF;

  IF v_min IS NOT NULL AND v_min > 0 AND NEW.estimated_fare_cup < v_min THEN
    RAISE EXCEPTION 'estimated_fare_cup % is below the minimum fare % for service % (server-side fare floor / tamper guard)',
      NEW.estimated_fare_cup, v_min, NEW.service_type;
  END IF;

  RETURN NEW;
END;
$function$
;

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
$function$
;

CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ref RECORD;
  v_completed_count INTEGER;
  v_flag_enabled BOOLEAN := false;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  -- 00477: welcome bonus for the referee
  v_welcome_trc INTEGER;
  v_referee_account_id UUID;
  v_referee_balance INTEGER;
  v_welcome_txn_id UUID;
BEGIN
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT (value::TEXT)::BOOLEAN INTO v_flag_enabled
    FROM feature_flags WHERE key = 'referral_program_enabled';
  EXCEPTION WHEN OTHERS THEN
    v_flag_enabled := false;
    RAISE WARNING 'feature_flags.referral_program_enabled cast failed, treating as false';
  END;

  IF NOT COALESCE(v_flag_enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = NEW.customer_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_completed_count
  FROM rides
  WHERE customer_id = NEW.customer_id
    AND status = 'completed';

  IF v_completed_count != 1 THEN
    RETURN NEW;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_bonus_cup', 500), 0)::integer, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- 00394: defensive money block — a referral-reward failure must NEVER roll
  -- back the ride completion that fired this trigger.
  BEGIN
    -- 00394: credit the referrer's spendable TriciCoin (driver->tricicoin,
    -- passenger->customer_cash) instead of a hardcoded 'customer_cash'.
    v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, _gift_wallet_type(v_ref.referrer_id));
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

    SELECT balance INTO v_platform_balance
      FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;
    SELECT balance INTO v_referrer_balance
      FROM wallet_accounts WHERE id = v_referrer_account_id FOR UPDATE;

    BEGIN
      INSERT INTO ledger_transactions (
        id, idempotency_key, type, status,
        reference_type, reference_id,
        description, created_by
      ) VALUES (
        gen_random_uuid(),
        'referral_bonus:' || v_ref.id::TEXT,
        'promo_credit', 'posted',
        'referral', v_ref.id,
        'Bono de referido - codigo ' || v_ref.code,
        v_ref.referrer_id
      )
      RETURNING id INTO v_txn_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN NEW;
    END;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

    UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
    UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

    UPDATE referrals
    SET status = 'rewarded',
        rewarded_at = NOW(),
        transaction_id = v_txn_id
    WHERE id = v_ref.id;

    -- 00477: optional welcome bonus for the REFEREE. Config-derived (mint-guard
    -- pattern, 00428), own idempotency key shared with the admin path. The
    -- platform row is already locked above; re-read its balance because the
    -- referrer leg just debited it.
    v_welcome_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_welcome_bonus_cup', 0), 0)::integer, v_exchange_rate);
    IF v_welcome_trc > 0 THEN
      v_referee_account_id := ensure_wallet_account(v_ref.referee_id, _gift_wallet_type(v_ref.referee_id));
      SELECT balance INTO v_referee_balance
        FROM wallet_accounts WHERE id = v_referee_account_id FOR UPDATE;
      SELECT balance INTO v_platform_balance
        FROM wallet_accounts WHERE id = v_platform_account_id;

      BEGIN
        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status,
          reference_type, reference_id,
          description, created_by
        ) VALUES (
          gen_random_uuid(),
          'referral_welcome:' || v_ref.id::TEXT,
          'promo_credit', 'posted',
          'referral', v_ref.id,
          'Bono de bienvenida por referido - codigo ' || v_ref.code,
          v_ref.referee_id
        )
        RETURNING id INTO v_welcome_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_welcome_txn_id, v_platform_account_id, -v_welcome_trc, v_platform_balance - v_welcome_trc);

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_welcome_txn_id, v_referee_account_id, v_welcome_trc, v_referee_balance + v_welcome_trc);

        UPDATE wallet_accounts SET balance = balance - v_welcome_trc WHERE id = v_platform_account_id;
        UPDATE wallet_accounts SET balance = balance + v_welcome_trc WHERE id = v_referee_account_id;
      EXCEPTION WHEN unique_violation THEN
        NULL; -- welcome bonus already paid (idempotent)
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'referral reward (on_complete) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_send_gift(p_to_user_id uuid, p_amount integer, p_note text, p_admin_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_is_admin BOOLEAN;
  v_to_type  wallet_account_type;
  v_to_account_id UUID;
  v_new_balance INTEGER;
  v_to_active BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
  v_platform_account_id UUID;
  v_platform_balance INTEGER;
BEGIN
  IF auth.uid() <> p_admin_user_id THEN
    RAISE EXCEPTION 'Forbidden: p_admin_user_id must match caller';
  END IF;
  SELECT (role IN ('admin', 'super_admin')) INTO v_is_admin FROM users WHERE id = p_admin_user_id;
  IF NOT COALESCE(v_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Gift amount must be positive';
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) < 3 THEN
    RAISE EXCEPTION 'Reason/note is required (min 3 chars)';
  END IF;
  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  v_to_type := _gift_wallet_type(p_to_user_id);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  v_platform_account_id := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_promotions');
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by
  )
  VALUES (
    'admin_gift:' || gen_random_uuid()::TEXT, 'promo_credit', 'posted', 'admin_action',
    p_admin_user_id, p_note, jsonb_build_object('kind', 'gift', 'admin', true), p_admin_user_id
  )
  RETURNING id INTO v_txn_id;

  UPDATE wallet_accounts SET balance = balance - p_amount, updated_at = NOW() WHERE id = v_platform_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -p_amount, v_platform_balance - p_amount);

  UPDATE wallet_accounts SET balance = balance + p_amount, updated_at = NOW()
    WHERE user_id = p_to_user_id AND account_type = v_to_type
  RETURNING id, balance INTO v_to_account_id, v_new_balance;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_new_balance);

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (NULL, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (p_admin_user_id, 'send_gift', 'user', p_to_user_id::TEXT, p_note);

  RETURN v_transfer_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.admin_send_gift(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_gift(uuid, integer, text, uuid) TO authenticated, service_role;

-- LIVE trigger definitions.
CREATE TRIGGER rides_create_estimate_snapshot AFTER INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_create_estimate_snapshot();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup, shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_promo_discount();
CREATE TRIGGER trg_referral_reward_on_complete AFTER UPDATE ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (old.status <> 'completed'::ride_status))) EXECUTE FUNCTION trg_referral_reward_on_complete();
CREATE TRIGGER trg_rides_validate_estimated_fare BEFORE INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_estimated_fare();

-- Seed: prod's auto_standard (4 active bands, 2026-10-07 maxima: base 599,
-- per km 947, per min 77, minimum 3288) and moto (no rules: config only).
INSERT INTO public.service_type_configs (slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup) VALUES
  ('auto_standard', 230, 500, 40, 1551),
  ('mensajeria', 453, 300, 30, 2038);
INSERT INTO public.pricing_rules (service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup) VALUES
  ('auto_standard', 599, 947, 77, 3288),
  ('auto_standard', 450, 700, 60, 1551),
  ('auto_standard', 400, 650, 55, 1551),
  ('auto_standard', 500, 800, 65, 2500);
INSERT INTO public.pricing_rules (service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, is_active) VALUES
  ('auto_standard', 99999, 99999, 9999, 99999, false);
INSERT INTO public.platform_config (key, value) VALUES
  ('commission_rate', '0.15'), ('referral_bonus_cup', '500'), ('referral_welcome_bonus_cup', '0');
INSERT INTO public.feature_flags (key, value) VALUES ('referral_program_enabled', 'true');

RESET ROLE;
