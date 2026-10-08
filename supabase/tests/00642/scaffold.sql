-- Scaffold for the 00641 rehearsal (marketing role in the admin panel).
-- Prod's tables as of 2026-10-08, reduced to the columns the code under test reads, prod's
-- policies on them, and the LIVE bodies of the functions 00641 patches or calls
-- (live-bodies.sql, dumped from prod; run.sh checks every body against prod's md5).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- Every object belongs to a NON-superuser role named postgres, as in prod, so RLS applies to
-- anon, authenticated and service_role and not to the owner.
-- Simplified on purpose: no foreign keys to auth.users, no RLS on ride_transitions, and the
-- tables only the promo trigger's partner and shared-ride branches read (not reached here) have
-- no RLS. PostGIS is left out: rides.dropoff_location and driver_profiles.current_location are
-- geography in prod and text stand-ins here (no test sets them; the partner lookup that would
-- call ST_DWithin only runs with a dropoff).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  full_name text NOT NULL DEFAULT '',
  phone text,
  email text,
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customer_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  rating_avg numeric NOT NULL DEFAULT 5.00
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  rating_avg numeric,
  is_online boolean NOT NULL DEFAULT false,
  -- the live GPS the panel view must leave out (geography in prod)
  current_location text,
  current_heading numeric,
  last_heartbeat_at timestamptz DEFAULT now()
);
-- Prod's types and defaults. pickup_address, dropoff_address, service_type and dropoff_location are
-- NOT NULL in prod; nullable here so the seed and the tests need not invent them.
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  service_type text,
  city_id uuid,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  final_fare_cup integer,
  final_fare_trc integer,
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  pickup_address text,
  dropoff_address text,
  dropoff_location text,
  ride_mode text NOT NULL DEFAULT 'passenger',
  corporate_account_id uuid,
  discount_amount_cup integer NOT NULL DEFAULT 0,
  shared_ride boolean NOT NULL DEFAULT false,
  shared_ride_seats_occupied integer,
  shared_ride_discount_cup integer NOT NULL DEFAULT 0,
  partner_place_id uuid,
  partner_discount_cup integer NOT NULL DEFAULT 0,
  -- live tracking of the ride, which the panel view must leave out
  share_token text,
  share_token_expires_at timestamptz
);
CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
);
CREATE TABLE public.ride_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid,
  from_status public.ride_status,
  to_status public.ride_status,
  actor_id uuid,
  actor_role public.user_role,
  reason text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id),
  account_type public.wallet_account_type NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);
CREATE TABLE public.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid REFERENCES public.users(id),
  referee_id uuid REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'pending',
  bonus_amount integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz
);
CREATE TABLE public.referral_codes (code text PRIMARY KEY, user_id uuid);
CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text,
  target_type text,
  target_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  title_es text,
  body_es text,
  image_url text,
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz,
  first_ride_only boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT true
);
-- Prod's FK actions (2026-10-08): rides and campaigns SET NULL, promotion_uses CASCADE.
ALTER TABLE public.rides ADD COLUMN promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL;
CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id),
  ride_id uuid REFERENCES public.rides(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, user_id)
);
-- What tg_rides_validate_promo_discount reads besides rides and promotions (reduced columns).
CREATE TABLE public.ride_pricing_snapshots (ride_id uuid NOT NULL, snapshot_type text NOT NULL, total integer NOT NULL);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, max_passengers integer NOT NULL DEFAULT 2);
CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_percent numeric NOT NULL DEFAULT 10,
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  location text NOT NULL,
  radius_m integer NOT NULL DEFAULT 80
);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), commission_percent numeric);
CREATE TABLE public.admin_promo_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL,
  ride_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  promo_code_id uuid,
  discount_amount_cup_supplied integer NOT NULL,
  estimated_fare_cup integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  segment_type text NOT NULL,
  segment_city_id uuid,
  message_title text NOT NULL,
  message_body text NOT NULL,
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'push',
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  sent_count integer DEFAULT 0,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  audience_role text NOT NULL DEFAULT 'customer'
);
CREATE TABLE public.home_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_es text NOT NULL,
  body_es text,
  image_url text,
  cta_label_es text,
  cta_url text,
  is_active boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  city_id uuid,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz
);
CREATE TABLE public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title_es text NOT NULL,
  title_en text NOT NULL,
  excerpt_es text NOT NULL DEFAULT '',
  excerpt_en text NOT NULL DEFAULT '',
  body_es text NOT NULL DEFAULT '',
  body_en text NOT NULL DEFAULT '',
  cover_image_url text,
  is_published boolean DEFAULT false,
  published_at timestamptz,
  author_id uuid REFERENCES public.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notify_on_publish boolean NOT NULL DEFAULT true,
  notified_at timestamptz
);
CREATE TABLE public.acquisition_codes (
  code text PRIMARY KEY,
  label text NOT NULL,
  channel text NOT NULL,
  audience text NOT NULL DEFAULT 'ambos',
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);
CREATE TABLE public.cms_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title_es text NOT NULL,
  title_en text NOT NULL,
  body_es text NOT NULL,
  body_en text NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES public.users(id)
);

-- The live functions. current_user_role and is_super_admin are LANGUAGE sql, so users must exist first.
\ir live-bodies.sql

-- 00517: anon may not call current_user_role() (is_admin() returns early for it).
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;

-- Live bodies of the two ride triggers that claim and give back a promotion use, dumped from
-- prod on 2026-10-08 with pg_get_functiondef (read-only MCP query); run.sh (L1) checks each md5.
-- Both are SECURITY DEFINER owned by postgres, so inside them current_user is postgres.
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

  IF COALESCE(v_use_existed, false) THEN
    UPDATE promotions
    SET current_uses = GREATEST(current_uses - 1, 0)
    WHERE id = NEW.promo_code_id;
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
$function$
;

-- tg_rides_validate_promo_discount reads it only for shared rides and partner places, which the
-- tests never create; the real one reads platform_config.
CREATE FUNCTION public.get_platform_config_numeric(p_key text, p_default numeric) RETURNS numeric
LANGUAGE sql STABLE AS $f$ SELECT p_default $f$;

-- apply_user_rating calls it; the real one averages reviews and cancellation events.
CREATE FUNCTION public.recompute_user_rating(p_user_id uuid) RETURNS numeric
LANGUAGE sql AS $f$ SELECT 4.25::numeric $f$;

-- Prod's RLS and policies on these tables (2026-10-08).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.home_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cms_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotion_uses ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY dp_admin_select ON public.driver_profiles FOR SELECT USING (is_admin());
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY r_admin_select ON public.rides FOR SELECT USING (is_admin());
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING ((customer_id = (SELECT auth.uid())) OR is_admin());
-- Prod's r_select_driver also lets a driver read a ride it has a pending offer for (ride_offers);
-- that table is not in this scaffold, so only the assigned-driver part is reproduced.
CREATE POLICY r_select_driver ON public.rides FOR SELECT USING (driver_id IN (SELECT driver_profiles.id
  FROM public.driver_profiles WHERE driver_profiles.user_id = (SELECT auth.uid())));
CREATE POLICY r_insert ON public.rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));
CREATE POLICY r_update ON public.rides FOR UPDATE USING ((customer_id = (SELECT auth.uid()))
  OR (driver_id IN (SELECT driver_profiles.id FROM public.driver_profiles WHERE driver_profiles.user_id = (SELECT auth.uid())))
  OR is_admin());
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY ref_select ON public.referrals FOR SELECT
  USING ((referrer_id = (SELECT auth.uid())) OR (referee_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY referral_codes_admin_all ON public.referral_codes FOR ALL USING (is_admin());
CREATE POLICY referral_codes_select_own ON public.referral_codes FOR SELECT
  USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY promo_admin ON public.promotions FOR ALL USING (is_admin());
CREATE POLICY pu_insert ON public.promotion_uses FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY pu_own ON public.promotion_uses FOR SELECT USING ((user_id = auth.uid()) OR is_admin());
CREATE POLICY "Admin full access on campaigns" ON public.campaigns FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY ha_admin_all ON public.home_announcements FOR ALL USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY ha_public_read ON public.home_announcements FOR SELECT
  USING (is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()));
CREATE POLICY blog_posts_admin_all ON public.blog_posts FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY blog_posts_public_read ON public.blog_posts FOR SELECT USING (is_published = true);
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
CREATE POLICY "Admins can manage cms_content" ON public.cms_content FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
CREATE POLICY "Anyone can read cms_content" ON public.cms_content FOR SELECT USING (true);

-- Prod's triggers (pg_get_triggerdef, 2026-10-08).
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER dp_ensure_driver_role_and_tricicoin AFTER INSERT OR UPDATE OF status ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_driver_role_and_tricicoin_on_approval();
CREATE TRIGGER trg_acquisition_codes_guard BEFORE INSERT OR UPDATE OF code ON public.acquisition_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_acquisition_codes_guard();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup,
  shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_promo_discount();
CREATE TRIGGER tg_rides_rollback_promo_on_cancel AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (((new.status = 'canceled'::public.ride_status) AND (old.status <> 'canceled'::public.ride_status)))
  EXECUTE FUNCTION public.tg_rides_rollback_promo_on_cancel();

-- Prod's valid_transitions (2026-10-08).
INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('disputed', 'completed', '{admin,super_admin}'),
  ('searching', 'accepted', '{driver,admin,super_admin}'),
  ('accepted', 'driver_en_route', '{driver,admin,super_admin}'),
  ('driver_en_route', 'arrived_at_pickup', '{driver,admin,super_admin}'),
  ('arrived_at_pickup', 'in_progress', '{driver,admin,super_admin}'),
  ('in_progress', 'completed', '{driver,admin,super_admin}'),
  ('in_progress', 'disputed', '{customer,driver,admin,super_admin}'),
  ('searching', 'canceled', '{customer,admin,super_admin}'),
  ('accepted', 'canceled', '{customer,driver,admin,super_admin}'),
  ('arrived_at_pickup', 'canceled', '{customer,driver,admin,super_admin}'),
  ('in_progress', 'arrived_at_destination', '{driver,admin,super_admin}'),
  ('arrived_at_destination', 'completed', '{driver,admin,super_admin}'),
  ('arrived_at_destination', 'disputed', '{customer,driver,admin,super_admin}'),
  ('driver_en_route', 'canceled', '{customer,driver,admin,super_admin}'),
  ('completed', 'disputed', '{customer,driver,admin,super_admin}'),
  ('arrived_at_destination', 'canceled', '{admin,super_admin}'),
  ('in_progress', 'canceled', '{admin,driver,customer,super_admin}'),
  ('accepted', 'searching', '{admin,super_admin}'),
  ('driver_en_route', 'searching', '{admin,super_admin}');

-- Seed: Ana (admin), Sara (super_admin), Carla (customer), Diego (approved driver) and Mara,
-- who run.sh turns into marketing once 00640 has added the value.
INSERT INTO public.users (id, full_name, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Ana Admin', 'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'Sara Super', 'super_admin'),
  ('c0000000-0000-4000-8000-000000000001', 'Carla Cliente', 'customer'),
  ('c0000000-0000-4000-8000-000000000002', 'Diego Driver', 'driver'),
  ('c0000000-0000-4000-8000-000000000003', 'Mara Marketing', 'customer');
INSERT INTO public.customer_profiles (user_id) VALUES
  ('c0000000-0000-4000-8000-000000000001'), ('c0000000-0000-4000-8000-000000000003');
INSERT INTO public.driver_profiles (id, user_id, status) VALUES
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'approved');
INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'customer_cash', 500);
INSERT INTO public.rides (id, customer_id) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.referrals (referrer_id, referee_id) VALUES
  ('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001');
INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'seed', 'user', 'c0000000-0000-4000-8000-000000000001', 'seed row');
INSERT INTO public.promotions (id, code, type, discount_percent, is_active, current_uses) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'LIVE10', 'percentage_discount', 10, true, 0),
  ('e0000000-0000-4000-8000-000000000002', 'USED5', 'percentage_discount', 5, false, 3);
INSERT INTO public.cms_content (slug, title_es, title_en, body_es, body_en)
  VALUES ('terms', 'Términos', 'Terms', 'Texto', 'Text');
INSERT INTO public.blog_posts (slug, title_es, title_en, is_published) VALUES ('hola', 'Hola', 'Hello', true);
