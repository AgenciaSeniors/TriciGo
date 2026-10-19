-- Scaffold for the 00666 rehearsal (local Postgres 16, no PostGIS needed).
-- The tables and columns the promotions guard, the platform_config audit, the
-- signup-code stats and the driver bonus (wallets, ledger, phone claims, push)
-- read, with the LIVE bodies read from prod on 2026-10-19 (live-bodies.sql) and
-- their EXECUTE grants as read (the acl in each header comment; run.sh S0 checks
-- every md5 and every grant). Two stand-ins: get_service_role_key() returns a
-- fixed test key (prod reads the vault), and net.http_post() queues the request
-- in net.http_request_queue instead of sending it, so a push is observable.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role. Like prod, new functions and tables in public get
-- privileges for anon, authenticated and service_role by default (set at the
-- end, so the live grants stay as read).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS net;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER SCHEMA net OWNER TO tricigo_owner;

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
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
CREATE TYPE public.ledger_entry_type AS ENUM ('recharge', 'ride_payment', 'ride_hold', 'ride_hold_release', 'commission',
  'transfer_in', 'transfer_out', 'promo_credit', 'redemption', 'adjustment', 'insurance_premium', 'refund',
  'quota_deduction', 'quota_recharge', 'fx_revaluation');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending', 'posted', 'archived', 'reversed');

-- 00619 + 00665: acquisition codes (the promotion link's key is added once promotions exists).
CREATE TABLE public.acquisition_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9-]{3,24}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  channel text NOT NULL CHECK (channel IN ('influencer', 'ugc', 'bolsas', 'pantallas', 'grupos', 'medios', 'otro')),
  audience text NOT NULL DEFAULT 'ambos' CHECK (audience IN ('pasajeros', 'choferes', 'ambos')),
  is_active boolean NOT NULL DEFAULT true,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  promotion_id uuid
);

CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  signup_code text REFERENCES public.acquisition_codes(code) ON UPDATE CASCADE,
  signup_code_at timestamptz
);

CREATE TABLE public.platform_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
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
  is_public boolean NOT NULL DEFAULT true,
  pending_approval boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  revision integer NOT NULL DEFAULT 0
);
ALTER TABLE public.acquisition_codes
  ADD CONSTRAINT acquisition_codes_promotion_id_fkey FOREIGN KEY (promotion_id)
  REFERENCES public.promotions(id) ON DELETE SET NULL;

-- Read by tg_acquisition_codes_guard.
CREATE TABLE public.referral_codes (code text PRIMARY KEY, user_id uuid);

-- Delete actions as in prod: a deleted account takes its driver profile (00001), and its
-- rides keep their history with no driver (00438).
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'approved'
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id) ON DELETE SET NULL,
  status public.ride_status NOT NULL DEFAULT 'searching',
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL
);

CREATE TABLE public.promotion_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES public.promotions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  ride_id uuid
);

CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'c',
  promo_code_id uuid REFERENCES public.promotions(id) ON DELETE SET NULL
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC',
  anchor_usd_cents numeric,
  UNIQUE (user_id, account_type),
  CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (account_type <> 'customer_cash' OR balance >= 0)
);

CREATE TABLE public.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'pending',
  reference_type text,
  reference_id uuid,
  description text NOT NULL DEFAULT '',
  metadata jsonb,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id),
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 00658: salt and claims (lock tables, no foreign keys: a claim outlives its account).
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

-- 00506: what cron_http_post records for each request.
CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname text NOT NULL,
  url text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);

-- Read by the live get_current_exchange_rate() (nothing in the rehearsal calls it).
CREATE TABLE public.exchange_rates (
  usd_cup_rate numeric NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- pg_net stand-in: the request is queued, never sent.
CREATE TABLE net.http_request_queue (
  id bigserial PRIMARY KEY,
  url text,
  headers jsonb,
  body jsonb
);
CREATE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
                              timeout_milliseconds integer DEFAULT 5000)
 RETURNS bigint
 LANGUAGE sql
AS $function$
  INSERT INTO net.http_request_queue (url, headers, body)
  VALUES (http_post.url, http_post.headers, http_post.body)
  RETURNING id;
$function$;
REVOKE ALL ON FUNCTION net.http_post(text, jsonb, jsonb, integer) FROM PUBLIC;

-- LIVE function bodies. live-bodies.sql is alphabetical, so a LANGUAGE sql body
-- (current_user_role) is created before auth.uid() exists; skip the creation-time
-- body check for this one load.
SET check_function_bodies = off;
\ir live-bodies.sql
RESET check_function_bodies;

-- Stand-in for the vault read: run.sh S0 skips this one md5.
CREATE OR REPLACE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT 'test-service-key'::text
$function$;

-- EXECUTE grants as read from prod (the acl in each header of live-bodies.sql; the
-- owner, supabase_auth_admin and dashboard_user left out). run.sh S0b checks them.
DO $grants$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p
    WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace)
      AND p.proname IN ('_claim_reward', '_gift_wallet_type', '_platform_config_audit_value',
        '_platform_config_is_telemetry', '_reward_claim_status', '_reward_identity_hash', 'admin_signup_code_stats',
        'apply_signup_code', 'uid', 'cron_http_post', 'cup_to_trc_centavos', 'current_user_role',
        'ensure_wallet_account', 'get_current_exchange_rate', 'get_platform_config_numeric', 'get_service_role_key',
        'is_admin', 'is_marketing', 'is_super_admin', 'platform_config_can_read_secrets', 'platform_config_is_secret',
        'promotion_is_referenced', 'tg_acquisition_codes_guard', 'tg_platform_config_audit',
        'tg_promotions_marketing_guard')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.fn);
  END LOOP;
END
$grants$;
GRANT EXECUTE ON FUNCTION public._claim_reward(uuid, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._gift_wallet_type(uuid) TO PUBLIC, service_role;
GRANT EXECUTE ON FUNCTION public._platform_config_audit_value(jsonb, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._platform_config_is_telemetry(text) TO service_role;
GRANT EXECUTE ON FUNCTION public._reward_claim_status(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public._reward_identity_hash(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_signup_code(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_http_post(text, text, jsonb, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.cup_to_trc_centavos(numeric, numeric) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_current_exchange_rate() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric(text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_service_role_key() TO service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_config_can_read_secrets() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_config_is_secret(text) TO PUBLIC, service_role;
GRANT EXECUTE ON FUNCTION public.promotion_is_referenced(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tg_acquisition_codes_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_platform_config_audit() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_promotions_marketing_guard() TO service_role;

-- Test helper (not in prod): runs one statement as the current role and answers
-- 'ok:<rows>' or 'err:<sqlstate>:<detail, or the message when there is none>',
-- so one test can see several outcomes of the same transaction.
CREATE FUNCTION public.t_try(p_sql text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_rows bigint;
  v_state text;
  v_detail text;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN 'ok:' || v_rows;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
  RETURN 'err:' || v_state || ':' || coalesce(nullif(v_detail, ''), SQLERRM);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.t_try(text) TO PUBLIC;

-- Policies, as in prod.
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
CREATE POLICY promo_admin ON public.promotions USING (is_admin());
CREATE POLICY promotions_select_marketing ON public.promotions FOR SELECT TO authenticated USING ((SELECT is_marketing()));
CREATE POLICY promotions_insert_marketing ON public.promotions FOR INSERT TO authenticated WITH CHECK ((SELECT is_marketing()));
CREATE POLICY promotions_update_marketing ON public.promotions FOR UPDATE TO authenticated USING ((SELECT is_marketing())) WITH CHECK ((SELECT is_marketing()));
CREATE POLICY promotions_delete_marketing ON public.promotions FOR DELETE TO authenticated USING ((SELECT is_marketing()));
ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY pc_select ON public.platform_config FOR SELECT USING ((NOT platform_config_is_secret(key)) OR platform_config_can_read_secrets());
CREATE POLICY pc_super_admin_insert ON public.platform_config FOR INSERT WITH CHECK (is_super_admin());
CREATE POLICY pc_super_admin_update ON public.platform_config FOR UPDATE USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY pc_super_admin_delete ON public.platform_config FOR DELETE USING (is_super_admin());
ALTER TABLE public.acquisition_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY acquisition_codes_admin_all ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
CREATE POLICY acquisition_codes_all_marketing ON public.acquisition_codes FOR ALL TO authenticated
  USING ((SELECT is_marketing())) WITH CHECK ((SELECT is_marketing()));
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = (SELECT auth.uid())) OR is_admin());

-- Table grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.promotions, public.platform_config, public.acquisition_codes TO authenticated;
GRANT SELECT ON public.users TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- LIVE trigger definitions.
CREATE TRIGGER trg_promotions_marketing_guard BEFORE INSERT OR DELETE OR UPDATE ON public.promotions FOR EACH ROW EXECUTE FUNCTION tg_promotions_marketing_guard();
CREATE TRIGGER platform_config_audit AFTER INSERT OR DELETE OR UPDATE ON public.platform_config FOR EACH ROW EXECUTE FUNCTION tg_platform_config_audit();
CREATE TRIGGER trg_acquisition_codes_guard BEFORE INSERT OR UPDATE OF code ON public.acquisition_codes FOR EACH ROW EXECUTE FUNCTION tg_acquisition_codes_guard();

-- Seeds. Phones in E.164 without '+', as GoTrue stores them.
--   …0001 platform (owns platform_promotions)   …0099 the deleted-account placeholder (00657)
--   ADMIN a…01   SUPER a…02   MARK a…03 (marketing)   RIDER b…06 (phone 5355500006)
--   DRV1 d…01 VIGO 5355500011 (DP1)   DRV2 d…02 VIGO phone never confirmed (DP2)
--   DRV3 d…03 ZERO 5355500013 (DP3)   DRV4 d…04 no code 5355500014 (DP4)
--   DRV5 (d…05, DP5) is created by a test: a new account on DRV1's phone.
INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, NULL),
  ('00000000-0000-0000-0000-000000000099', NULL, NULL),
  ('a0000000-0000-4000-8000-000000000001', NULL, NULL),
  ('a0000000-0000-4000-8000-000000000002', NULL, NULL),
  ('a0000000-0000-4000-8000-000000000003', NULL, NULL),
  ('b0000000-0000-4000-8000-000000000006', '5355500006', now()),
  ('d0000000-0000-4000-8000-000000000001', '5355500011', now()),
  ('d0000000-0000-4000-8000-000000000002', '5355500012', NULL),
  ('d0000000-0000-4000-8000-000000000003', '5355500013', now()),
  ('d0000000-0000-4000-8000-000000000004', '5355500014', now());

INSERT INTO public.acquisition_codes (code, label, channel) VALUES
  ('VIGO', 'Vigo', 'influencer'),
  ('ZERO', 'Sin saldo', 'otro');

INSERT INTO public.users (id, role, full_name, phone, signup_code, signup_code_at) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', 'TriciGo', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-000000000099', 'customer', 'Usuario eliminado', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000001', 'admin', 'Admin', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000002', 'super_admin', 'Super', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000003', 'marketing', 'Mark', NULL, NULL, NULL),
  ('b0000000-0000-4000-8000-000000000006', 'customer', 'Rider', '+5355500006', NULL, NULL),
  ('d0000000-0000-4000-8000-000000000001', 'driver', 'Driver One', '+5355500011', 'VIGO', now()),
  ('d0000000-0000-4000-8000-000000000002', 'driver', 'Driver Two', '+5355500012', 'VIGO', now()),
  ('d0000000-0000-4000-8000-000000000003', 'driver', 'Driver Three', '+5355500013', 'ZERO', now()),
  ('d0000000-0000-4000-8000-000000000004', 'driver', 'Driver Four', '+5355500014', NULL, NULL);

INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('dd000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001'),
  ('dd000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002'),
  ('dd000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003'),
  ('dd000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004');

-- JSON numbers, as prod stores the four amounts; one secret-looking key.
INSERT INTO public.platform_config (key, value) VALUES
  ('referral_bonus_cup', '500'),
  ('referral_bonus_driver_cup', '1000'),
  ('referral_welcome_bonus_cup', '0'),
  ('referral_welcome_bonus_driver_cup', '0'),
  ('x_api_key', '"s"');

-- LIVE10: active and used. PAUSED5: paused, unused. REF15: paused, unused, named by a ride.
INSERT INTO public.promotions (id, code, type, discount_percent, discount_fixed_cup, is_active, current_uses,
                               created_by, approved_by, approved_at, title_es) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'LIVE10', 'percentage_discount', 10, NULL, true, 1,
   'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '2026-10-01 12:00:00+00', 'Diez'),
  ('e0000000-0000-4000-8000-000000000002', 'PAUSED5', 'fixed_discount', NULL, 100, false, 0,
   'a0000000-0000-4000-8000-000000000001', NULL, NULL, 'Cien'),
  ('e0000000-0000-4000-8000-000000000003', 'REF15', 'percentage_discount', 15, NULL, false, 0,
   'a0000000-0000-4000-8000-000000000001', NULL, NULL, 'Quince');
INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000006');
INSERT INTO public.rides (id, customer_id, status, promo_code_id) VALUES
  ('f0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000006', 'canceled',
   'e0000000-0000-4000-8000-000000000003');

INSERT INTO public.reward_identity_salt (id, salt) VALUES (1, repeat('ab', 32));
INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES
  ('00000000-0000-0000-0000-000000000001', 'platform_promotions', 0);
INSERT INTO public.exchange_rates (usd_cup_rate, is_current) VALUES (510, true);

-- Like prod (measured 2026-09-27): new functions and tables in public get privileges
-- for the API roles until a migration revokes them.
ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

RESET ROLE;
