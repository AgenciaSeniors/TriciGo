-- Scaffold for the 00665 rehearsal (local Postgres 16, no PostGIS needed).
-- The tables and columns the promo validator, the cancel rollback,
-- get_my_signup_promotion() and admin_signup_code_stats() read, with the LIVE
-- bodies and EXECUTE grants read from prod on 2026-10-17 (live-bodies.sql;
-- run.sh S0 checks every md5). PostGIS is replaced by text columns and two
-- stubs: the validator only calls ST_DWithin / ST_Distance in its partner-place
-- query, and the rehearsal has no partner places. A NON-superuser role (prod:
-- postgres) owns everything; run.sh applies the migration as that role. Like
-- prod, new functions in public get EXECUTE for anon, authenticated and
-- service_role by default (set at the end, so the live grants stay as read).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  phone text UNIQUE,
  phone_confirmed_at timestamptz
);

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.promotion_type AS ENUM ('percentage_discount', 'fixed_discount', 'bonus_credit');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'approved'
);
CREATE TABLE public.service_type_configs (slug text PRIMARY KEY, max_passengers integer NOT NULL DEFAULT 4);

CREATE TABLE public.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  type public.promotion_type NOT NULL,
  discount_percent numeric,
  discount_fixed_cup integer,
  is_active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now() - interval '1 day',
  valid_until timestamptz,
  max_uses integer,
  current_uses integer NOT NULL DEFAULT 0,
  first_ride_only boolean NOT NULL DEFAULT false
);
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, commission_percent numeric);
CREATE TABLE public.partner_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_active boolean NOT NULL DEFAULT true,
  valid_until timestamptz,
  location text NOT NULL,
  radius_m integer NOT NULL,
  discount_percent numeric NOT NULL
);
CREATE TABLE public.admin_promo_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid, ride_id uuid, customer_id uuid, promo_code_id uuid,
  discount_amount_cup_supplied integer, estimated_fare_cup integer, notes text
);

-- rides: the columns the triggers read; locations as text (no PostGIS).
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  service_type text NOT NULL REFERENCES public.service_type_configs(slug),
  ride_mode text NOT NULL DEFAULT 'passenger',
  pickup_location text NOT NULL,
  dropoff_location text NOT NULL,
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ride_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX promotion_uses_promotion_id_user_id_key ON public.promotion_uses USING btree (promotion_id, user_id)
  WHERE (user_id <> '00000000-0000-0000-0000-000000000099'::uuid);
ALTER TABLE public.promotion_uses ENABLE ROW LEVEL SECURITY;

-- 00658: salt and claims (lock tables).
CREATE TABLE public.reward_identity_salt (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt text NOT NULL
);
ALTER TABLE public.reward_identity_salt ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.reward_claims (
  identity_hash text NOT NULL,
  claim text NOT NULL,
  user_id uuid NOT NULL,
  ride_id uuid,
  referral_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (identity_hash, claim)
);
ALTER TABLE public.reward_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_identity_salt, public.reward_claims TO service_role;

-- 00619: acquisition codes (LIVE columns and grants) and users.signup_code.
CREATE TABLE public.acquisition_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9-]{3,24}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  channel text NOT NULL CHECK (channel IN ('influencer', 'ugc', 'bolsas', 'pantallas', 'grupos', 'medios', 'otro')),
  audience text NOT NULL DEFAULT 'ambos' CHECK (audience IN ('pasajeros', 'choferes', 'ambos')),
  is_active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);
ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.acquisition_codes TO authenticated, service_role;
ALTER TABLE public.users ADD COLUMN signup_code text REFERENCES public.acquisition_codes(code) ON UPDATE CASCADE;

-- LIVE function bodies and EXECUTE grants. live-bodies.sql is alphabetical, so a
-- LANGUAGE sql body (current_user_role) is created before auth.uid() exists; skip
-- the creation-time body check for this one load.
SET check_function_bodies = off;
\ir live-bodies.sql
RESET check_function_bodies;

-- Policies (after auth.uid(), is_admin() and is_marketing() exist).
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY rides_insert_own ON public.rides FOR INSERT WITH CHECK (customer_id = auth.uid());
CREATE POLICY rides_select_own ON public.rides FOR SELECT USING (customer_id = auth.uid() OR is_admin());
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
CREATE POLICY acquisition_codes_all_marketing ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT public.is_marketing())) WITH CHECK ((SELECT public.is_marketing()));

-- PostGIS stubs: no partner place ever matches.
CREATE FUNCTION public.st_dwithin(text, text, integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false';
CREATE FUNCTION public.st_distance(text, text) RETURNS double precision LANGUAGE sql IMMUTABLE AS 'SELECT 0::double precision';

-- Simplified estimate snapshot (prod: tg_rides_create_estimate_snapshot):
-- the contract is total = the estimated fare the insert left.
CREATE FUNCTION public.tg_rides_create_estimate_snapshot()
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
$function$;

-- LIVE trigger definitions.
CREATE TRIGGER rides_create_estimate_snapshot AFTER INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_create_estimate_snapshot();
CREATE TRIGGER rides_validate_promo_discount BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup, shared_ride, shared_ride_seats_occupied, dropoff_location, corporate_account_id ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_promo_discount();
CREATE TRIGGER tg_rides_rollback_promo_on_cancel AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'canceled'::ride_status) AND (old.status <> 'canceled'::ride_status))) EXECUTE FUNCTION tg_rides_rollback_promo_on_cancel();

-- Seeds.
INSERT INTO public.service_type_configs (slug) VALUES ('auto_standard');
INSERT INTO public.platform_config (key, value) VALUES ('commission_rate', '0.15');
INSERT INTO public.reward_identity_salt (id, salt) VALUES (1, repeat('ab', 32));
INSERT INTO public.users (id, role, full_name) VALUES
  ('00000000-0000-0000-0000-000000000099', 'customer', 'Usuario eliminado');

-- Like prod: new functions in public are executable by the API roles until a
-- migration revokes it.
ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

RESET ROLE;
