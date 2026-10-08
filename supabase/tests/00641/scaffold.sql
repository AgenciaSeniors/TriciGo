-- Scaffold for the 00641 rehearsal (marketing role in the admin panel).
-- Prod's tables as of 2026-10-08, reduced to the columns the code under test reads, prod's
-- policies on them, and the LIVE bodies of the functions 00641 patches or calls
-- (live-bodies.sql, dumped from prod; run.sh checks every body against prod's md5).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- Every object belongs to a NON-superuser role named postgres, as in prod, so RLS applies to
-- anon, authenticated and service_role and not to the owner.
-- Simplified on purpose: no foreign keys to auth.users, no RLS on ride_transitions.
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
  rating_avg numeric
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
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

CREATE POLICY users_admin_select ON public.users FOR SELECT USING (is_admin());
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING (id = (SELECT auth.uid()));
CREATE POLICY dp_admin_select ON public.driver_profiles FOR SELECT USING (is_admin());
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated
  USING ((user_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY r_admin_select ON public.rides FOR SELECT USING (is_admin());
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING ((customer_id = (SELECT auth.uid())) OR is_admin());
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
