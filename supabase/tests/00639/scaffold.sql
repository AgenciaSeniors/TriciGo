-- Scaffold for the 00639 rehearsal: payment_intents, the wallet and ledger
-- tables with the columns and CHECKs prod has, prod's grants and policies on
-- payment_intents as LIVE on 2026-10-08 (after 00627), and the LIVE bodies of
-- process_recharge_refund and tg_ledger_maintain_usd_anchor (md5/length
-- checked by S0). cron_http_post records its calls in a table instead of
-- sending; get_current_exchange_rate() returns app.test_rate (default 770).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST.
-- A non-superuser (tricigo_owner) owns everything, like postgres in prod.
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
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

SET ROLE tricigo_owner;

CREATE TYPE public.ledger_entry_type AS ENUM ('recharge','ride_payment','ride_hold','ride_hold_release','commission','transfer_in','transfer_out','promo_credit','redemption','adjustment','insurance_premium','refund','quota_deduction','quota_recharge','fx_revaluation');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending','posted','archived','reversed');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash','driver_cash','driver_hold','platform_revenue','platform_promotions','corporate_cash','driver_quota','tricicoin','platform_fx_reserve');

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, created_by uuid);

CREATE TABLE public.wallet_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  held_balance integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TRC'::text,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  anchor_usd_cents numeric,
  unbacked_cup integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type),
  CONSTRAINT chk_anchor_usd_cents_nonneg CHECK (((anchor_usd_cents IS NULL) OR (anchor_usd_cents >= (0)::numeric))),
  CONSTRAINT chk_unbacked_cup_nonneg CHECK ((unbacked_cup >= 0)),
  CONSTRAINT wallet_accounts_customer_balance_non_negative CHECK (((account_type <> 'customer_cash'::wallet_account_type) OR (balance >= 0)))
);
CREATE TABLE public.ledger_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'pending'::ledger_transaction_status,
  reference_type text,
  reference_id uuid,
  description text NOT NULL DEFAULT ''::text,
  metadata jsonb,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.ledger_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- payment_intents: prod's columns, CHECKs and indexes on 2026-10-08.
CREATE TABLE public.payment_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  tropipay_id text,
  payment_url text,
  short_url text,
  amount_cup integer NOT NULL,
  amount_usd numeric,
  exchange_rate numeric,
  status text NOT NULL DEFAULT 'created'::text,
  recharge_request_id uuid,
  transaction_id uuid,
  tropipay_reference text,
  tropipay_response jsonb,
  webhook_payload jsonb,
  error_message text,
  paid_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  corporate_account_id uuid,
  stripe_payment_intent_id text,
  payment_provider text DEFAULT 'stripe'::text,
  fee_usd numeric DEFAULT 0,
  intent_type text,
  ride_id uuid,
  card_brand text,
  card_last4 text,
  recharge_type text NOT NULL DEFAULT 'customer'::text,
  provider_error_code text,
  client_ip text,
  user_agent text,
  device_fingerprint text,
  metadata jsonb,
  CONSTRAINT payment_intents_amount_cup_nonneg CHECK ((amount_cup >= 0)),
  CONSTRAINT payment_intents_amount_usd_nonneg CHECK (((amount_usd IS NULL) OR (amount_usd >= (0)::numeric))),
  CONSTRAINT payment_intents_fee_usd_nonneg CHECK (((fee_usd IS NULL) OR (fee_usd >= (0)::numeric))),
  CONSTRAINT payment_intents_recharge_type_chk CHECK ((recharge_type = ANY (ARRAY['customer'::text, 'driver_quota'::text, 'tricicoin'::text]))),
  CONSTRAINT payment_intents_status_check CHECK ((status = ANY (ARRAY['created'::text, 'pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'expired'::text, 'refunded'::text]))),
  CONSTRAINT payment_intents_tropipay_reference_key UNIQUE (tropipay_reference)
);
CREATE INDEX idx_payment_intents_user ON public.payment_intents USING btree (user_id, created_at DESC);
CREATE INDEX idx_payment_intents_stripe_pi_id ON public.payment_intents USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);

-- Grants as live: anon/authenticated keep INSERT, REFERENCES, SELECT, TRIGGER on
-- payment_intents after 00627; service_role has everything.
GRANT ALL ON public.payment_intents, public.wallet_accounts, public.ledger_transactions, public.ledger_entries,
  public.platform_config, public.corporate_accounts TO service_role;
GRANT INSERT, REFERENCES, SELECT, TRIGGER ON public.payment_intents TO anon, authenticated;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
-- Live policies (pg_policy on 2026-10-08). Roles {} = PUBLIC.
CREATE POLICY pi_own_insert ON public.payment_intents FOR INSERT WITH CHECK ((user_id = auth.uid()));
CREATE POLICY pi_own_select ON public.payment_intents FOR SELECT USING ((user_id = auth.uid()));

-- Stubs ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_exchange_rate() RETURNS numeric
 LANGUAGE sql STABLE AS $$ SELECT COALESCE(nullif(current_setting('app.test_rate', true), '')::numeric, 770) $$;
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
 LANGUAGE sql STABLE AS $$ SELECT 'sb_secret_TEST'::text $$;
CREATE TABLE public.test_http_calls (jobname text, body jsonb, called_at timestamptz DEFAULT clock_timestamp());
GRANT ALL ON public.test_http_calls TO PUBLIC;
-- cron_http_post: same signature as prod (00506); records instead of sending.
-- With app.test_http_fail = '1' it raises, like a broken vault or pg_net.
CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
BEGIN
  IF current_setting('app.test_http_fail', true) = '1' THEN RAISE EXCEPTION 'test: http unavailable'; END IF;
  INSERT INTO public.test_http_calls (jobname, body) VALUES (p_jobname, body);
  RETURN 1;
END $$;

-- LIVE bodies --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_ledger_maintain_usd_anchor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_type     public.wallet_account_type;
  v_txn_type public.ledger_entry_type;
  v_rate     numeric;
  v_spend    integer;
  v_meta     jsonb;
  v_dir      jsonb;
BEGIN
  SELECT account_type INTO v_type FROM public.wallet_accounts WHERE id = NEW.account_id;
  IF v_type IS NULL OR v_type NOT IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN
    RETURN NEW;
  END IF;

  SELECT type, metadata INTO v_txn_type, v_meta FROM public.ledger_transactions WHERE id = NEW.transaction_id;
  IF v_txn_type IN ('fx_revaluation', 'ride_hold', 'ride_hold_release') THEN
    RETURN NEW;
  END IF;

  IF NEW.amount = 0 THEN RETURN NEW; END IF;

  IF v_meta ? 'anchor_directives' AND jsonb_typeof(v_meta->'anchor_directives') = 'array' THEN
    SELECT d INTO v_dir
    FROM jsonb_array_elements(v_meta->'anchor_directives') d
    WHERE (d->>'account_id')::uuid = NEW.account_id
    LIMIT 1;
    IF v_dir IS NOT NULL THEN
      UPDATE public.wallet_accounts
         SET anchor_usd_cents = GREATEST(0, COALESCE(anchor_usd_cents, 0) + COALESCE((v_dir->>'anchor_usd_cents_delta')::numeric, 0)),
             unbacked_cup     = GREATEST(0, unbacked_cup + COALESCE((v_dir->>'unbacked_cup_delta')::integer, 0)),
             updated_at = now()
       WHERE id = NEW.account_id;
      RETURN NEW;
    END IF;
  END IF;

  IF v_txn_type = 'promo_credit' THEN
    IF NEW.amount < 0 THEN
      PERFORM 1 FROM public.wallet_accounts WHERE id = NEW.account_id AND unbacked_cup + NEW.amount < 0;
      IF FOUND THEN
        RAISE NOTICE 'promo_credit clawback exceeds unbacked balance for wallet % (entry %)', NEW.account_id, NEW.id;
      END IF;
    END IF;
    UPDATE public.wallet_accounts
       SET unbacked_cup = GREATEST(0, unbacked_cup + NEW.amount), updated_at = now()
     WHERE id = NEW.account_id;
    RETURN NEW;
  END IF;

  v_rate := public.get_current_exchange_rate();
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.amount > 0 THEN
    UPDATE public.wallet_accounts
       SET anchor_usd_cents = COALESCE(anchor_usd_cents, 0) + NEW.amount / v_rate * 100,
           updated_at = now()
     WHERE id = NEW.account_id;
  ELSE
    v_spend := -NEW.amount;
    UPDATE public.wallet_accounts
       SET unbacked_cup = unbacked_cup - LEAST(unbacked_cup, v_spend),
           anchor_usd_cents = GREATEST(
             0,
             COALESCE(anchor_usd_cents, 0) - (v_spend - LEAST(unbacked_cup, v_spend)) / v_rate * 100
           ),
           updated_at = now()
     WHERE id = NEW.account_id;
  END IF;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_ledger_maintain_usd_anchor AFTER INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION tg_ledger_maintain_usd_anchor();

CREATE OR REPLACE FUNCTION public.process_recharge_refund(p_payment_intent_id uuid, p_webhook_payload jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_intent RECORD;
  v_account_id UUID;
  v_account_user UUID;
  v_account_type TEXT;
  v_refund_txn_id UUID;
  v_idempotency_key TEXT;
  v_orig_usd_cents numeric;
  v_rate_today numeric;
  v_debit_cup integer;
  v_bal_before integer;
  v_metadata jsonb;
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;
  IF v_intent.status = 'refunded' THEN
    SELECT id INTO v_refund_txn_id FROM ledger_transactions
    WHERE idempotency_key = 'recharge_refund_' || p_payment_intent_id::TEXT;
    RETURN v_refund_txn_id;
  END IF;
  IF v_intent.status <> 'completed' THEN
    RAISE EXCEPTION 'Cannot refund intent in status %; expected completed', v_intent.status;
  END IF;
  IF v_intent.corporate_account_id IS NOT NULL THEN
    SELECT created_by INTO v_account_user FROM corporate_accounts WHERE id = v_intent.corporate_account_id;
    IF v_account_user IS NULL THEN
      RAISE EXCEPTION 'Corporate account % not found', v_intent.corporate_account_id;
    END IF;
    v_account_type := 'corporate_cash';
  ELSE
    v_account_user := v_intent.user_id;
    IF v_intent.recharge_type IN ('tricicoin', 'driver_quota') THEN
      v_account_type := 'tricicoin';
    ELSE
      v_account_type := 'customer_cash';
    END IF;
  END IF;
  SELECT id INTO v_account_id FROM wallet_accounts
  WHERE user_id = v_account_user AND account_type = v_account_type::wallet_account_type;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Wallet account not found';
  END IF;

  v_idempotency_key := 'recharge_refund_' || p_payment_intent_id::TEXT;
  SELECT id INTO v_refund_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_refund_txn_id IS NOT NULL THEN
    UPDATE payment_intents SET status = 'refunded',
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      updated_at = NOW() WHERE id = p_payment_intent_id;
    RETURN v_refund_txn_id;
  END IF;

  v_orig_usd_cents := COALESCE(v_intent.amount_usd * 100,
                               v_intent.amount_cup / NULLIF(v_intent.exchange_rate, 0) * 100);
  v_metadata := jsonb_build_object(
    'payment_provider', v_intent.payment_provider,
    'provider_intent_id', v_intent.stripe_payment_intent_id,
    'refund_amount_cup', v_intent.amount_cup,
    'refund_amount_usd', v_intent.amount_usd,
    'corporate_account_id', v_intent.corporate_account_id,
    'webhook_payload', p_webhook_payload
  );

  IF v_orig_usd_cents IS NOT NULL AND v_orig_usd_cents > 0 THEN
    v_rate_today := public.get_current_exchange_rate();
    v_debit_cup  := ROUND(v_orig_usd_cents / 100.0 * v_rate_today)::int;
    v_metadata := v_metadata || jsonb_build_object(
      'refund_debited_cup', v_debit_cup,
      'refund_original_usd_cents', v_orig_usd_cents,
      'anchor_directives', jsonb_build_array(jsonb_build_object(
        'account_id', v_account_id,
        'anchor_usd_cents_delta', -v_orig_usd_cents
      ))
    );
  ELSE
    v_debit_cup := v_intent.amount_cup;
  END IF;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, metadata, created_by
  ) VALUES (
    v_idempotency_key, 'refund', 'posted', 'payment_intent', p_payment_intent_id,
    'Refund of wallet recharge: -' || v_debit_cup || ' CUP (~-$' || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    v_metadata,
    v_intent.user_id
  ) RETURNING id INTO v_refund_txn_id;

  SELECT balance INTO v_bal_before FROM wallet_accounts WHERE id = v_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_refund_txn_id, v_account_id, -v_debit_cup, v_bal_before - v_debit_cup);
  UPDATE wallet_accounts SET balance = balance - v_debit_cup, updated_at = NOW()
  WHERE id = v_account_id;

  UPDATE payment_intents SET status = 'refunded',
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
    updated_at = NOW() WHERE id = p_payment_intent_id;
  RETURN v_refund_txn_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.process_recharge_refund(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_recharge_refund(uuid, jsonb) TO service_role;

RESET ROLE;
