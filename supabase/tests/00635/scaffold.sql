-- Scaffold for the 00635 rehearsal: the LIVE production bodies of every function that
-- e-mails a user's own address (users.email), of the two that e-mail a trusted contact,
-- of send_gift and of check_rate_limit, plus their LIVE trigger definitions, transcribed
-- from pg_get_functiondef and pg_get_triggerdef on 2026-10-07 (00631 applied).
-- run.sh S0 compares md5/length of every prosrc with prod.
--
-- The owner is a NON-superuser role named postgres, as in prod, member of anon,
-- authenticated and service_role. The cluster's superuser is pgtest; run.sh applies
-- the migration as postgres. No Supabase stack: auth.uid() reads
-- request.jwt.claim.sub like PostgREST sets it.
--
-- Stubs, with the live signatures:
--   * net.http_post records each call in net.http_request_queue (one row = one request;
--     the tests count the rows whose url ends in /send-email).
--   * get_service_role_key returns a constant; get_current_exchange_rate returns 500;
--     ensure_wallet_account inserts the account if missing; is_admin reads users.role;
--     _normalize_cuban_phone returns its input.
-- Not modelled: the ledger and wallet triggers (USD anchor, balance checks), RLS on the
-- tables (every function under test is SECURITY DEFINER), and the other triggers on
-- rides, driver_profiles, payment_intents and wallet_transfers.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
CREATE SCHEMA IF NOT EXISTS net AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'corporate_cash', 'tricicoin',
  'platform_revenue', 'platform_promotions', 'platform_fx_reserve');

-- pg_net stand-in: one row per request instead of an HTTP call
CREATE TABLE net.http_request_queue (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE sql
  AS $f$ INSERT INTO net.http_request_queue (url, headers, body) VALUES (url, headers, body) RETURNING id $f$;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- auth.identities: the columns the tests read (prod: owned by supabase_auth_admin, postgres can SELECT)
CREATE TABLE auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  provider_id text NOT NULL DEFAULT gen_random_uuid()::text,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Tables, with the live columns the bodies read (types as in prod)
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  phone text,
  email text,
  email_verified_at timestamp with time zone,
  is_active boolean NOT NULL DEFAULT true
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE TABLE public.rate_limits (
  key text NOT NULL,
  window_start timestamp with time zone NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  is_frozen boolean NOT NULL DEFAULT false,
  unbacked_cup integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_type)
);

CREATE TABLE public.ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  type text NOT NULL,
  status text NOT NULL,
  reference_type text,
  reference_id uuid,
  description text,
  metadata jsonb,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL
);

CREATE TABLE public.wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid,
  to_user_id uuid NOT NULL,
  amount integer NOT NULL,
  note text,
  transaction_id uuid,
  kind text NOT NULL DEFAULT 'gift',
  reversal_of uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid,
  action text,
  target_type text,
  target_id text,
  reason text
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification',
  suspended_reason text
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid,
  service_type text NOT NULL DEFAULT 'triciclo_basico',
  status public.ride_status NOT NULL DEFAULT 'searching',
  ride_mode text NOT NULL DEFAULT 'passenger',
  payment_method text NOT NULL DEFAULT 'cash',
  share_token text,
  pickup_address text NOT NULL DEFAULT 'Calle 23 e/ L y M',
  dropoff_address text DEFAULT 'Obispo e/ Habana y Compostela',
  estimated_fare_cup integer DEFAULT 1500,
  final_fare_cup integer,
  estimated_distance_m integer DEFAULT 3000,
  actual_distance_m integer,
  estimated_duration_s integer DEFAULT 600,
  actual_duration_s integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);

CREATE TABLE public.ride_pricing_snapshots (
  ride_id uuid NOT NULL,
  base_fare integer, per_km_rate integer, per_minute_rate integer,
  distance_m integer, duration_s integer, surge_multiplier numeric,
  subtotal integer, total integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.delivery_details (
  ride_id uuid NOT NULL,
  recipient_name text,
  package_category text,
  delivery_photo_url text,
  delivery_otp_validated_at timestamp with time zone
);

CREATE TABLE public.payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  status text NOT NULL DEFAULT 'pending',
  amount_cup integer,
  amount_usd numeric
);

CREATE TABLE public.trusted_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text,
  phone text,
  email text,
  auto_share boolean NOT NULL DEFAULT true
);

-- Stubs
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'svc-key'::text $f$;
CREATE FUNCTION public.get_current_exchange_rate() RETURNS numeric LANGUAGE sql STABLE AS $f$ SELECT 500::numeric $f$;
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'super_admin')) $f$;
CREATE FUNCTION public._normalize_cuban_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT p $f$;
CREATE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_account_type public.wallet_account_type)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
  AS $f$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_account_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type) VALUES (p_user_id, p_account_type) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $f$;

-- ===================== live bodies (2026-10-07) =====================

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_requests integer, p_window_seconds integer)
 RETURNS TABLE(allowed boolean, current_count integer, reset_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$
;
REVOKE ALL ON FUNCTION public.check_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, integer, integer) TO service_role;

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
GRANT EXECUTE ON FUNCTION public._gift_wallet_type(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.send_gift(p_from_user_id uuid, p_to_user_id uuid, p_amount integer, p_note text DEFAULT NULL::text, p_from_wallet wallet_account_type DEFAULT NULL::wallet_account_type, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_from_type wallet_account_type;
  v_to_type   wallet_account_type;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_from_balance INTEGER;
  v_to_balance   INTEGER;
  v_from_frozen  BOOLEAN;
  v_to_frozen    BOOLEAN;
  v_to_active    BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
  v_dup UUID;
  v_from_unbacked INTEGER;
  v_rate numeric;
  v_unbacked_used INTEGER;
  v_backed_used INTEGER;
  v_backed_usd_cents numeric;
  v_metadata jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only gift from your own wallet';
  END IF;

  IF auth.uid() <> p_from_user_id THEN
    INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
    VALUES (auth.uid(), 'send_gift_on_behalf', 'user', p_from_user_id::TEXT, COALESCE(p_note, 'Regalo'));
  END IF;

  IF p_amount <= 0 THEN RAISE EXCEPTION 'Gift amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot gift to yourself'; END IF;

  IF p_from_wallet IS NOT NULL
     AND p_from_wallet NOT IN ('customer_cash'::wallet_account_type, 'tricicoin'::wallet_account_type) THEN
    RAISE EXCEPTION 'Invalid gift source wallet: %', p_from_wallet;
  END IF;

  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT wt.id INTO v_dup
    FROM wallet_transfers wt
    JOIN ledger_transactions lt ON lt.id = wt.transaction_id
    WHERE lt.idempotency_key = p_idempotency_key
    LIMIT 1;
    IF v_dup IS NOT NULL THEN
      RETURN v_dup;
    END IF;
  END IF;

  SELECT id INTO v_dup
  FROM wallet_transfers
  WHERE from_user_id = p_from_user_id
    AND to_user_id = p_to_user_id
    AND amount = p_amount
    AND kind = 'gift'
    AND reversal_of IS NULL
    AND created_at > NOW() - INTERVAL '10 seconds'
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RETURN v_dup;
  END IF;

  v_from_type := COALESCE(p_from_wallet, _gift_wallet_type(p_from_user_id));
  v_to_type   := _gift_wallet_type(p_to_user_id);

  PERFORM ensure_wallet_account(p_from_user_id, v_from_type);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  SELECT id, balance, is_frozen, COALESCE(unbacked_cup, 0)
    INTO v_from_account_id, v_from_balance, v_from_frozen, v_from_unbacked
    FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = v_from_type FOR UPDATE;
  IF COALESCE(v_from_frozen, false) THEN
    RAISE EXCEPTION 'Your wallet is frozen';
  END IF;
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;

  SELECT id, balance, is_frozen INTO v_to_account_id, v_to_balance, v_to_frozen
    FROM wallet_accounts
    WHERE user_id = p_to_user_id AND account_type = v_to_type FOR UPDATE;
  IF COALESCE(v_to_frozen, false) THEN
    RAISE EXCEPTION 'Recipient wallet is frozen';
  END IF;

  v_rate := public.get_current_exchange_rate();
  v_unbacked_used := LEAST(v_from_unbacked, p_amount);
  v_backed_used := p_amount - v_unbacked_used;
  v_backed_usd_cents := CASE WHEN v_rate > 0 THEN ROUND(v_backed_used / v_rate * 100) ELSE 0 END;
  v_metadata := jsonb_build_object('kind', 'gift', 'anchor_directives', jsonb_build_array(
    jsonb_build_object('account_id', v_from_account_id, 'unbacked_cup_delta', -v_unbacked_used, 'anchor_usd_cents_delta', -v_backed_usd_cents),
    jsonb_build_object('account_id', v_to_account_id,   'unbacked_cup_delta',  v_unbacked_used, 'anchor_usd_cents_delta',  v_backed_usd_cents)
  ));

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, description, metadata, created_by
  )
  VALUES (
    COALESCE(p_idempotency_key, 'gift:' || gen_random_uuid()::TEXT), 'transfer_out', 'posted', 'wallet_transfer',
    COALESCE(p_note, 'Regalo'), v_metadata, p_from_user_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);
  UPDATE wallet_accounts SET balance = v_from_balance - p_amount, updated_at = NOW()
    WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);
  UPDATE wallet_accounts SET balance = v_to_balance + p_amount, updated_at = NOW()
    WHERE id = v_to_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  DECLARE
    v_service_key TEXT;
    v_from_name   TEXT;
  BEGIN
    v_service_key := get_service_role_key();
    IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
      SELECT full_name INTO v_from_name FROM users WHERE id = p_from_user_id;
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', v_service_key,
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_id', p_to_user_id,
          'title', '🎁 Recibiste un regalo',
          'body', COALESCE(NULLIF(v_from_name, ''), 'Alguien')
                  || ' te regaló ' || p_amount::text || ' TriciCoin'
                  || CASE WHEN COALESCE(p_note, '') <> '' THEN ': ' || p_note ELSE '' END,
          'category', 'wallet_credit',
          'data', jsonb_build_object(
            'type', 'wallet_credit',
            'transfer_id', v_transfer_id::text,
            'amount', p_amount::text,
            'from_name', COALESCE(v_from_name, '')
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_transfer_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.send_gift(uuid, uuid, integer, text, public.wallet_account_type, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_gift(uuid, uuid, integer, text, public.wallet_account_type, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.send_driver_payout_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_role TEXT; v_balance INTEGER;
  v_from_name TEXT;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN RETURN NEW; END IF;

  SELECT u.email, u.full_name, u.role::text
  INTO v_email, v_full_name, v_role
  FROM users u WHERE u.id = NEW.to_user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;

  IF NOT (NEW.kind = 'gift' AND NEW.reversal_of IS NULL) THEN
    IF NEW.amount < 5000 THEN RETURN NEW; END IF;
    IF v_role NOT IN ('driver','super_admin') THEN RETURN NEW; END IF;
  END IF;

  SELECT balance INTO v_balance FROM wallet_accounts
   WHERE user_id = NEW.to_user_id AND account_type = _gift_wallet_type(NEW.to_user_id) LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  IF NEW.kind = 'gift' AND NEW.reversal_of IS NULL THEN
    SELECT full_name INTO v_from_name FROM users WHERE id = NEW.from_user_id LIMIT 1;
    v_payload := jsonb_build_object(
      'template', 'gift_received', 'recipient_email', v_email,
      'subject', '🎁 Recibiste un regalo en TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount,
        'from_name', COALESCE(v_from_name, ''),
        'note', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at,
        'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  ELSE
    v_payload := jsonb_build_object(
      'template', 'driver_payout', 'recipient_email', v_email,
      'subject', 'Pago recibido — TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount, 'description', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at, 'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_cargo_bonus(p_ride_id uuid, p_driver_user_id uuid, p_amount_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_idempotency_key text := 'cargo_bonus:' || p_ride_id::text;
  v_account_id uuid;
  v_new_balance integer;
  v_tx_id uuid;
  v_existing_tx_id uuid;
  v_email text;
  v_full_name text;
  v_service_key text;
  v_platform_account_id uuid;
  v_platform_balance integer;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount');
  END IF;
  IF p_driver_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_driver');
  END IF;

  SELECT id INTO v_existing_tx_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key LIMIT 1;
  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'transaction_id', v_existing_tx_id, 'message', 'bonus already applied for this ride');
  END IF;

  -- BUG B fix: credit the live driver wallet (tricicoin), not the deprecated driver_cash.
  v_account_id := ensure_wallet_account(p_driver_user_id, 'tricicoin');

  -- 00414: double-entry — fund the incentive from platform_promotions (may go negative).
  v_platform_account_id := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_promotions');
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by, metadata)
  VALUES (v_idempotency_key, 'adjustment', 'posted', 'ride', p_ride_id, 'Bonus cargo +5% (OTP validado + foto delivery)', p_driver_user_id, jsonb_build_object('source', 'cargo_completion_trigger', 'ride_id', p_ride_id))
  RETURNING id INTO v_tx_id;

  UPDATE wallet_accounts SET balance = balance - p_amount_cents, updated_at = NOW() WHERE id = v_platform_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, v_platform_account_id, -p_amount_cents, v_platform_balance - p_amount_cents);

  UPDATE wallet_accounts SET balance = balance + p_amount_cents, updated_at = NOW() WHERE id = v_account_id RETURNING balance INTO v_new_balance;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, v_account_id, p_amount_cents, v_new_balance);

  BEGIN
    SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = p_driver_user_id LIMIT 1;
    v_service_key := get_service_role_key();
    IF v_email IS NOT NULL AND v_email <> '' AND v_service_key IS NOT NULL AND v_service_key <> '' THEN
      PERFORM net.http_post(
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key),
        body    := jsonb_build_object(
          'template', 'driver_payout',
          'recipient_email', v_email,
          'subject', 'Bonus cargo recibido - TriciGo',
          'data', jsonb_build_object(
            'full_name', COALESCE(v_full_name, ''),
            'amount_cup', p_amount_cents,
            'description', 'Bonus mensajería +5% por entrega completa con código y foto',
            'created_at', NOW(),
            'new_balance_cup', v_new_balance
          )
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[apply_cargo_bonus] email failed for ride %: %', p_ride_id, SQLERRM;
  END;

  RETURN jsonb_build_object('success', true, 'idempotent', false, 'transaction_id', v_tx_id, 'account_id', v_account_id, 'amount_cup', p_amount_cents, 'new_balance', v_new_balance);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', 'exception', 'detail', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$
;
REVOKE ALL ON FUNCTION public.apply_cargo_bonus(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_cargo_bonus(uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.send_first_ride_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_count INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  SELECT COUNT(*) INTO v_count FROM rides r WHERE r.customer_id = NEW.customer_id AND r.status = 'completed';
  IF v_count <> 1 THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'first_ride_celebration', 'recipient_email', v_email,
    'subject', '🎉 Tu primer viaje — TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''))
  );
  v_headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key,'apikey',v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_payment_failed_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_amount INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  v_amount := COALESCE(NEW.amount_cup, ROUND(NEW.amount_usd * get_current_exchange_rate())::integer);
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'payment_failed', 'recipient_email', v_email,
    'subject', 'No pudimos procesar tu pago — TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'amount_cup', v_amount, 'reason', '')
  );
  v_headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key,'apikey',v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_delivery_receipt_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_email TEXT; v_customer_name TEXT; v_driver_name TEXT;
  v_dd RECORD; v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.ride_mode <> 'cargo' OR NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_customer_email, v_customer_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;
  IF v_customer_email IS NULL OR v_customer_email = '' THEN RETURN NEW; END IF;
  IF NEW.driver_id IS NOT NULL THEN
    SELECT u.full_name INTO v_driver_name
    FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
    WHERE dp.id = NEW.driver_id LIMIT 1;
  END IF;
  SELECT recipient_name, package_category::text AS package_category,
    delivery_photo_url, delivery_otp_validated_at
  INTO v_dd FROM delivery_details WHERE ride_id = NEW.id LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'delivery_receipt_customer',
    'recipient_email', v_customer_email,
    'subject', 'Tu envío llegó — recibo TriciGo',
    'data', jsonb_build_object(
      'completed_at', NEW.completed_at,
      'pickup_address', NEW.pickup_address,
      'dropoff_address', NEW.dropoff_address,
      'driver_name', COALESCE(v_driver_name, ''),
      'recipient_name', COALESCE(v_dd.recipient_name, ''),
      'package_category', COALESCE(v_dd.package_category, ''),
      'delivery_photo_url', v_dd.delivery_photo_url,
      'delivery_otp_validated_at', v_dd.delivery_otp_validated_at,
      'final_fare', COALESCE(NEW.final_fare_cup, NEW.estimated_fare_cup, 0)
    )
  );
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_driver_status_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_template TEXT; v_subject TEXT;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB; v_reason TEXT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  IF NEW.status::text = 'approved' THEN
    v_template := 'driver_approved'; v_subject := '¡Tu cuenta TriciGo Conductor fue aprobada!';
  ELSIF NEW.status::text = 'rejected' THEN
    v_template := 'driver_rejected'; v_subject := 'Tu solicitud TriciGo Conductor — actualización';
    v_reason := '';
  ELSIF NEW.status::text = 'suspended' THEN
    v_template := 'driver_suspended'; v_subject := 'Tu cuenta TriciGo Conductor fue suspendida';
    v_reason := COALESCE(NEW.suspended_reason, '');
  ELSE
    RETURN NEW;
  END IF;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', v_template, 'recipient_email', v_email, 'subject', v_subject,
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'reason', COALESCE(v_reason, ''))
  );
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_ride_receipt_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_email TEXT;
  v_driver_name    TEXT;
  v_snapshot       RECORD;
  v_payload        JSONB;
  v_service_key    TEXT;
  v_headers        JSONB;
  v_distance_km    NUMERIC;
  v_duration_min   NUMERIC;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT email INTO v_customer_email FROM users WHERE id = NEW.customer_id LIMIT 1;
  IF v_customer_email IS NULL OR v_customer_email = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.driver_id IS NOT NULL THEN
    SELECT u.full_name INTO v_driver_name
    FROM driver_profiles dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.id = NEW.driver_id
    LIMIT 1;
  END IF;

  SELECT base_fare, per_km_rate, per_minute_rate, distance_m, duration_s,
         surge_multiplier, subtotal, total
  INTO v_snapshot
  FROM ride_pricing_snapshots
  WHERE ride_id = NEW.id
  ORDER BY created_at DESC
  LIMIT 1;

  v_distance_km  := ROUND(COALESCE(NEW.actual_distance_m, NEW.estimated_distance_m, 0) / 1000.0, 2);
  v_duration_min := ROUND(COALESCE(NEW.actual_duration_s, NEW.estimated_duration_s, 0) / 60.0, 1);

  v_payload := jsonb_build_object(
    'template',         'ride_receipt',
    'recipient_email',  v_customer_email,
    'subject',          'Tu recibo de viaje TriciGo',
    'locale',           'es',
    'data', jsonb_build_object(
      'completed_at',      NEW.completed_at,
      'created_at',        NEW.created_at,
      'pickup_address',    NEW.pickup_address,
      'dropoff_address',   NEW.dropoff_address,
      'driver_name',       COALESCE(v_driver_name, ''),
      'service_type',      NEW.service_type,
      'payment_method',    NEW.payment_method,
      'distance_km',       v_distance_km,
      'duration_minutes',  v_duration_min,
      'base_fare',         COALESCE(v_snapshot.base_fare, 0),
      'distance_charge',   COALESCE(ROUND(v_snapshot.per_km_rate * v_snapshot.distance_m / 1000.0), 0),
      'time_charge',       COALESCE(ROUND(v_snapshot.per_minute_rate * v_snapshot.duration_s / 60.0), 0),
      'surge_multiplier',  COALESCE(v_snapshot.surge_multiplier, 1),
      'discount_amount',   0,
      'final_fare',        COALESCE(NEW.final_fare_cup, v_snapshot.total, NEW.estimated_fare_cup, 0),
      'estimated_fare',    NEW.estimated_fare_cup
    )
  );

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers,
    body    := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_accept()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_share_url TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.share_token IS NULL THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;
  v_share_url := 'https://tricigo.com/track/share/' || NEW.share_token;
  v_headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key);

  FOR v_contact IN
    SELECT tc.name AS contact_name,
           tc.email AS contact_email,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      v_payload := jsonb_build_object(
        'template', 'trusted_contact_ride_started',
        'recipient_email', v_contact.contact_email,
        'data', jsonb_build_object(
          'contact_name', COALESCE(v_contact.contact_name, ''),
          'rider_name', COALESCE(v_rider_name, 'Alguien'),
          'share_url', v_share_url
        )
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := v_headers,
        body := v_payload
      );
    ELSE
      v_sms_body := COALESCE(v_rider_name, 'Alguien') || ' ha iniciado un viaje con TriciGo. Sigue en tiempo real: ' || v_share_url;
      v_payload := jsonb_build_object(
        'user_id', NEW.customer_id::text,
        'phone', v_contact.contact_phone,
        'body', v_sms_body,
        'ride_id', NEW.id::text,
        'event_type', 'trusted_contact_share'
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
        headers := v_headers,
        body := v_payload
      );
    END IF;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_trusted_contacts_on_accept] dispatch FAILED for ride % (customer %): % %',
    NEW.id, NEW.customer_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_contact RECORD; v_rider_name TEXT; v_sms_body TEXT; v_payload JSONB;
  v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;
  v_headers := jsonb_build_object('Content-Type','application/json','apikey',v_service_key,'Authorization','Bearer '||v_service_key);

  FOR v_contact IN
    SELECT tc.name AS contact_name,
           tc.email AS contact_email,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id AND tc.auto_share = true
  LOOP
    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      v_payload := jsonb_build_object(
        'template', 'trusted_contact_ride_completed',
        'recipient_email', v_contact.contact_email,
        'data', jsonb_build_object(
          'contact_name', COALESCE(v_contact.contact_name, ''),
          'rider_name', COALESCE(v_rider_name, 'Tu contacto')
        )
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
        headers := v_headers,
        body := v_payload
      );
    ELSE
      v_sms_body := '✅ ' || COALESCE(v_rider_name, 'Tu contacto') || ' llegó a su destino de forma segura. — TriciGo';
      v_payload := jsonb_build_object(
        'user_id', NEW.customer_id::text,
        'phone', v_contact.contact_phone,
        'body', v_sms_body,
        'ride_id', NEW.id::text,
        'event_type', 'trip_completed_safe'
      );
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
        headers := v_headers,
        body := v_payload
      );
    END IF;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_trusted_contacts_on_complete] dispatch FAILED for ride % (customer %): % %',
    NEW.id, NEW.customer_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- Trigger function ACLs as in prod (the trigger functions are never called directly)
REVOKE ALL ON FUNCTION public.send_driver_payout_email(), public.send_first_ride_email(), public.send_payment_failed_email(),
  public.send_delivery_receipt_email(), public.send_driver_status_email(), public.send_ride_receipt_email(),
  public.notify_trusted_contacts_on_accept() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_driver_payout_email(), public.send_first_ride_email(), public.send_payment_failed_email(),
  public.send_delivery_receipt_email(), public.send_driver_status_email(), public.send_ride_receipt_email(),
  public.notify_trusted_contacts_on_accept(), public.notify_trusted_contacts_on_complete() TO service_role;

-- ===================== live triggers (pg_get_triggerdef, 2026-10-07) =====================
CREATE TRIGGER trg_notify_trusted_contacts AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'accepted'::ride_status) AND (old.status = 'searching'::ride_status))) EXECUTE FUNCTION notify_trusted_contacts_on_accept();
CREATE TRIGGER trg_notify_trusted_contacts_complete AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (old.status <> 'completed'::ride_status))) EXECUTE FUNCTION notify_trusted_contacts_on_complete();
CREATE TRIGGER trg_send_delivery_receipt AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (new.ride_mode = 'cargo'::text) AND (old.status IS DISTINCT FROM 'completed'::ride_status))) EXECUTE FUNCTION send_delivery_receipt_email();
CREATE TRIGGER trg_send_driver_payout_email AFTER INSERT ON public.wallet_transfers FOR EACH ROW EXECUTE FUNCTION send_driver_payout_email();
CREATE TRIGGER trg_send_driver_status_email AFTER UPDATE OF status ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION send_driver_status_email();
CREATE TRIGGER trg_send_first_ride_email AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (old.status IS DISTINCT FROM 'completed'::ride_status) AND (new.ride_mode = 'passenger'::text))) EXECUTE FUNCTION send_first_ride_email();
CREATE TRIGGER trg_send_payment_failed_email AFTER UPDATE OF status ON public.payment_intents FOR EACH ROW WHEN (((new.status = 'failed'::text) AND (old.status IS DISTINCT FROM 'failed'::text))) EXECUTE FUNCTION send_payment_failed_email();
CREATE TRIGGER trg_send_ride_receipt AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = 'completed'::ride_status) AND (old.status IS DISTINCT FROM 'completed'::ride_status) AND (new.ride_mode = 'passenger'::text))) EXECUTE FUNCTION send_ride_receipt_email();

-- As in prod: a function the migration creates gets EXECUTE for anon, authenticated and
-- service_role by default, so its REVOKEs are tested against real grants.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

RESET ROLE;
