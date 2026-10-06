-- Local rehearsal scaffold for migration 00591 (PR-1 of the 2026-09-15 payments audit).
-- Minimal prod-shaped schema. Function bodies marked LIVE are verbatim copies of
-- pg_get_functiondef()/prosrc captured from production on 2026-09-15; the ACLs
-- reproduce what has_function_privilege() reported in production that day.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash','driver_cash','driver_hold','platform_revenue','platform_promotions','corporate_cash','driver_quota','tricicoin','platform_fx_reserve');
CREATE TYPE public.ledger_entry_type AS ENUM ('recharge','ride_payment','ride_hold','ride_hold_release','commission','transfer_in','transfer_out','promo_credit','redemption','adjustment','insurance_premium','refund','quota_deduction','quota_recharge','fx_revaluation');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending','posted','archived','reversed');

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  is_active boolean NOT NULL DEFAULT true,
  full_name text
);

-- LIVE (prod 2026-09-15)
CREATE OR REPLACE FUNCTION public.current_user_role() RETURNS public.user_role
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$$;
-- LIVE (prod 2026-09-15): no AAL2 clause
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SET search_path = public, pg_catalog AS $$
  SELECT current_user_role() IN ('admin', 'super_admin');
$$;

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC',
  is_active boolean NOT NULL DEFAULT true,
  is_frozen boolean NOT NULL DEFAULT false,
  anchor_usd_cents numeric,
  unbacked_cup integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_accounts_user_id_account_type_key UNIQUE (user_id, account_type),
  CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (account_type <> 'customer_cash' OR balance >= 0),
  CONSTRAINT chk_anchor_usd_cents_nonneg CHECK (anchor_usd_cents IS NULL OR anchor_usd_cents >= 0),
  CONSTRAINT chk_unbacked_cup_nonneg CHECK (unbacked_cup >= 0)
);
ALTER TABLE public.wallet_accounts ENABLE ROW LEVEL SECURITY;
-- LIVE policies (prod 2026-09-15)
CREATE POLICY wa_select ON public.wallet_accounts FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());
CREATE POLICY wa_admin ON public.wallet_accounts FOR ALL USING (is_admin());
CREATE POLICY wa_insert_own ON public.wallet_accounts FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()) AND account_type IN ('customer_cash','driver_cash') AND balance = 0 AND COALESCE(held_balance, 0) = 0);

CREATE TABLE public.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'pending',
  reference_type text, reference_id uuid,
  description text NOT NULL DEFAULT '',
  metadata jsonb, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id),
  amount integer NOT NULL, balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL, usd_cup_rate numeric NOT NULL, fetched_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rate_limits (key text NOT NULL, window_start timestamptz NOT NULL, count integer NOT NULL, PRIMARY KEY (key, window_start));

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- LIVE
CREATE OR REPLACE FUNCTION public.get_current_exchange_rate() RETURNS numeric
LANGUAGE plpgsql SET search_path = public, extensions, pg_catalog AS $function$
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
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.get_fresh_exchange_rate() RETURNS numeric
LANGUAGE plpgsql SET search_path = public, extensions, pg_catalog AS $function$
DECLARE
  v_rate    NUMERIC;
  v_fetched TIMESTAMPTZ;
  v_max_age NUMERIC;
BEGIN
  SELECT usd_cup_rate, fetched_at INTO v_rate, v_fetched FROM exchange_rates WHERE is_current = true LIMIT 1;
  IF v_rate IS NULL OR v_fetched IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT (value #>> '{}')::NUMERIC INTO v_max_age FROM platform_config WHERE key = 'exchange_rate_max_age_hours';
  v_max_age := COALESCE(v_max_age, 24);
  IF v_max_age > 0 AND v_fetched < (now() - make_interval(hours => v_max_age::int)) THEN
    RAISE WARNING 'get_fresh_exchange_rate: is_current rate stale (fetched_at=%, max_age hours=%) -> NULL', v_fetched, v_max_age;
    RETURN NULL;
  END IF;
  RETURN v_rate;
END;
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO rate_limits (key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_max_requests,
    v_count,
    v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.refund_rate_limit(p_key text, p_window_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $function$
DECLARE
  v_window_start TIMESTAMPTZ;
BEGIN
  -- Same window math as check_rate_limit (00105) — fixed/tumbling window.
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  UPDATE rate_limits
    SET count = GREATEST(count - 1, 0)
    WHERE key = p_key
      AND window_start = v_window_start;
END;
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_type public.wallet_account_type DEFAULT 'customer_cash'::public.wallet_account_type)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $function$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;

-- LIVE
CREATE OR REPLACE FUNCTION public.revalue_anchored_wallets() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $function$
DECLARE
  v_rate       numeric;
  v_fx_account uuid;
  v_fx_balance integer;
  r            RECORD;
  v_bal        integer;
  v_anchor     numeric;
  v_unbacked   integer;
  v_target     integer;
  v_delta      integer;
  v_txn_id     uuid;
  v_key        text;
  v_count      integer := 0;
  v_platform   uuid := '00000000-0000-0000-0000-000000000001';
  c_deadband   constant integer := 1;
BEGIN
  v_rate := public.get_fresh_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE WARNING 'revalue_anchored_wallets: no exchange rate; skipping';
    RETURN 0;
  END IF;

  SELECT id, balance INTO v_fx_account, v_fx_balance
    FROM public.wallet_accounts WHERE account_type = 'platform_fx_reserve' LIMIT 1
    FOR UPDATE;
  IF v_fx_account IS NULL THEN
    RAISE WARNING 'revalue_anchored_wallets: platform_fx_reserve missing; skipping';
    RETURN 0;
  END IF;

  FOR r IN
    SELECT id FROM public.wallet_accounts
     WHERE account_type IN ('customer_cash', 'corporate_cash', 'tricicoin')
       AND anchor_usd_cents IS NOT NULL
     ORDER BY id
  LOOP
    SELECT balance, GREATEST(0, anchor_usd_cents), COALESCE(unbacked_cup, 0)
      INTO v_bal, v_anchor, v_unbacked
      FROM public.wallet_accounts WHERE id = r.id
      FOR UPDATE;

    v_target := ROUND(v_anchor / 100.0 * v_rate)::int + v_unbacked;
    v_delta  := v_target - v_bal;
    CONTINUE WHEN abs(v_delta) <= c_deadband;

    v_key := 'fx_reval:' || r.id::text || ':' || to_char((now() AT TIME ZONE 'UTC'), 'YYYYMMDD');
    IF EXISTS (SELECT 1 FROM public.ledger_transactions WHERE idempotency_key = v_key) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.ledger_transactions
      (idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by)
    VALUES
      (v_key, 'fx_revaluation', 'posted', 'wallet_account', r.id,
       'Ajuste por tipo de cambio (ancla USD)',
       jsonb_build_object('rate', v_rate, 'anchor_usd_cents', v_anchor, 'unbacked_cup', v_unbacked, 'delta_cup', v_delta),
       v_platform)
    RETURNING id INTO v_txn_id;

    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, r.id, v_delta, v_target);
    UPDATE public.wallet_accounts SET balance = v_target, updated_at = now() WHERE id = r.id;

    v_fx_balance := v_fx_balance - v_delta;
    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_fx_account, -v_delta, v_fx_balance);
    UPDATE public.wallet_accounts SET balance = v_fx_balance, updated_at = now() WHERE id = v_fx_account;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

-- Stubs with the prod signatures (bodies irrelevant to this migration; only their ACLs matter)
CREATE OR REPLACE FUNCTION public.recompute_cup_from_usd_prices() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;
CREATE OR REPLACE FUNCTION public.get_ride_with_coords(p_ride_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::jsonb $$;
CREATE OR REPLACE FUNCTION public.get_driver_weekly_summary(p_driver_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION public.check_fraud_signals(p_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION public.auto_offline_stale_drivers() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;
CREATE OR REPLACE FUNCTION public.notify_offline_drivers_for_searching_rides() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;
CREATE OR REPLACE FUNCTION public.recalc_ride_estimate_with_waypoints(p_ride_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;
CREATE OR REPLACE FUNCTION public.send_gift(p_from_user_id uuid, p_to_user_id uuid, p_amount integer, p_note text, p_from_wallet public.wallet_account_type DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN gen_random_uuid(); END $$;

-- Simulated internal callers (send_gift / complete_ride_and_pay call ensure_wallet_account for OTHER users and platform types)
CREATE OR REPLACE FUNCTION public._test_nested_ensure(p_user uuid, p_type public.wallet_account_type) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  RETURN ensure_wallet_account(p_user, p_type);
END $$;
CREATE OR REPLACE FUNCTION public._test_nested_ensure_sql(p_user uuid, p_type public.wallet_account_type) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT ensure_wallet_account(p_user, p_type)
$$;

-- ACLs as observed in prod on 2026-09-15 -------------------------------------
-- `=X` (PUBLIC) shape: anon + authenticated can execute
--   refund_rate_limit, revalue_anchored_wallets, recompute_cup_from_usd_prices,
--   get_ride_with_coords, notify_offline_drivers_for_searching_rides, send_gift
--   (Postgres default: EXECUTE granted to PUBLIC on creation — nothing to do)
-- explicit authenticated + service_role, no PUBLIC:
REVOKE ALL ON FUNCTION public.check_fraud_signals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_fraud_signals(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_driver_weekly_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_weekly_summary(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) TO authenticated, service_role;
-- already locked in prod (by a later migration than 00531):
REVOKE ALL ON FUNCTION public.auto_offline_stale_drivers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_offline_stale_drivers() TO service_role;

-- Fixtures ---------------------------------------------------------------------
INSERT INTO public.users (id, role, full_name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', 'platform'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'customer', 'Alice'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'driver', 'Bob'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'admin', 'Carol'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'customer', 'Mallory'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'customer', 'Eve');
INSERT INTO public.exchange_rates (source, usd_cup_rate, fetched_at, is_current) VALUES ('test', 700, now(), true);
-- the real FX reserve (as in prod: one row, owned by the platform user)
INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES ('00000000-0000-0000-0000-000000000001', 'platform_fx_reserve', 0);
