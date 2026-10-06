-- Scaffold for the 00615 rehearsal: the tables the referral payers read and write, with the
-- columns and enums read from prod on 2026-10-06, and the LIVE bodies of both referral
-- triggers byte-exact (prod md5(prosrc): on_complete 7f5dcb0663accaf345f2e16374a0545c,
-- on_driver_approved 18ba26bd32bd10f5f9ce43aab8cb9849; run.sh checks both).
-- Helpers: _gift_wallet_type, cup_to_trc_centavos and get_platform_config_numeric keep the
-- logic of the LIVE bodies (comments trimmed). get_current_exchange_rate and
-- ensure_wallet_account are stand-ins: the rate is ignored by cup_to_trc_centavos
-- (1 TRC = 1 CUP), and ensure_wallet_account only finds or
-- creates the row. It raises for a user named 'BOOM', which the tests use to prove that a
-- failing payout never rolls back the ride completion.
-- A NON-superuser role (prod: postgres) owns everything; run.sh applies the migration as it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT tricigo_owner TO pgtest;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.referral_status AS ENUM ('pending', 'rewarded', 'invalidated');
CREATE TYPE public.wallet_account_type AS ENUM ('customer_cash', 'driver_cash', 'driver_hold', 'platform_revenue',
  'platform_promotions', 'corporate_cash', 'driver_quota', 'tricicoin', 'platform_fx_reserve');
CREATE TYPE public.ledger_entry_type AS ENUM ('recharge', 'ride_payment', 'ride_hold', 'ride_hold_release',
  'commission', 'transfer_in', 'transfer_out', 'promo_credit', 'redemption', 'adjustment', 'insurance_premium',
  'refund', 'quota_deduction', 'quota_recharge', 'fx_revaluation');
CREATE TYPE public.ledger_transaction_status AS ENUM ('pending', 'posted', 'archived', 'reversed');

-- Only the columns the payers and the tests touch.
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id),
  status public.driver_status NOT NULL DEFAULT 'pending_verification'
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching'
);
CREATE TABLE public.feature_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.referrals (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES public.users(id),
  referee_id uuid NOT NULL UNIQUE REFERENCES public.users(id),
  code text NOT NULL,
  status public.referral_status NOT NULL DEFAULT 'pending',
  bonus_amount integer NOT NULL DEFAULT 500,
  transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewarded_at timestamptz
);
CREATE TABLE public.wallet_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  account_type public.wallet_account_type NOT NULL,
  balance integer NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_type)
);
CREATE TABLE public.ledger_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type public.ledger_entry_type NOT NULL,
  status public.ledger_transaction_status NOT NULL DEFAULT 'pending',
  reference_type text,
  reference_id uuid,
  description text NOT NULL DEFAULT '',
  metadata jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ledger_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES public.ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES public.wallet_accounts(id),
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- LIVE helper bodies.
CREATE FUNCTION public._gift_wallet_type(p_user_id uuid) RETURNS public.wallet_account_type
LANGUAGE sql STABLE AS $function$
  SELECT CASE WHEN u.role = 'driver' THEN 'tricicoin'::wallet_account_type
              ELSE 'customer_cash'::wallet_account_type END
  FROM users u WHERE u.id = p_user_id;
$function$;

CREATE FUNCTION public.cup_to_trc_centavos(p_cup_pesos numeric, p_exchange_rate numeric) RETURNS integer
LANGUAGE plpgsql AS $function$
BEGIN
  -- Rebase 00094: 1 TRC = 1 CUP (sin centavos). Devolver el CUP tal cual.
  -- p_exchange_rate se ignora (se conserva por compatibilidad de firma).
  RETURN ROUND(p_cup_pesos);
END;
$function$;

CREATE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric) RETURNS numeric
LANGUAGE plpgsql STABLE AS $function$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;
  RETURN COALESCE(v_out, p_fallback);
END;
$function$;

-- Stand-ins (see the header).
CREATE FUNCTION public.get_current_exchange_rate() RETURNS numeric
LANGUAGE sql STABLE AS $function$ SELECT 640.0::numeric $function$;

CREATE FUNCTION public.ensure_wallet_account(p_user_id uuid, p_account_type public.wallet_account_type) RETURNS uuid
LANGUAGE plpgsql AS $function$
DECLARE v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND full_name = 'BOOM') THEN
    RAISE EXCEPTION 'injected wallet failure for %', p_user_id;
  END IF;
  SELECT id INTO v_id FROM public.wallet_accounts WHERE user_id = p_user_id AND account_type = p_account_type;
  IF v_id IS NULL THEN
    INSERT INTO public.wallet_accounts (user_id, account_type) VALUES (p_user_id, p_account_type) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$function$;

-- LIVE referral payers (pg_get_functiondef, prod 2026-10-06).
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
$function$;

CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_driver_approved()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_driver_user_id UUID;
  v_ref RECORD;
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
  IF NEW.status != 'approved' OR OLD.status = 'approved' THEN
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

  v_driver_user_id := NEW.user_id;

  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = v_driver_user_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(GREATEST((CASE WHEN get_platform_config_numeric('referral_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_bonus_cup', 500) END), 0)::integer, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- 00394: defensive money block — a referral-reward failure must NEVER roll
  -- back the driver approval that fired this trigger.
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
        'referral_bonus_driver:' || v_ref.id::TEXT,
        'promo_credit', 'posted',
        'referral', v_ref.id,
        'Bono de referido conductor - codigo ' || v_ref.code,
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
        bonus_amount = v_bonus_trc,
        rewarded_at = NOW(),
        transaction_id = v_txn_id
    WHERE id = v_ref.id;

    -- 00477: optional welcome bonus for the REFEREE (the newly approved
    -- driver). Config-derived, idempotency key shared with the admin path.
    v_welcome_trc := cup_to_trc_centavos(GREATEST((CASE WHEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_welcome_bonus_cup', 0) END), 0)::integer, v_exchange_rate);
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
    RAISE WARNING 'referral reward (on_driver_approved) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_referral_reward_on_complete AFTER UPDATE ON public.rides FOR EACH ROW
  WHEN (((new.status = 'completed'::ride_status) AND (old.status <> 'completed'::ride_status)))
  EXECUTE FUNCTION trg_referral_reward_on_complete();
CREATE TRIGGER trg_referral_reward_on_driver_approved AFTER UPDATE ON public.driver_profiles FOR EACH ROW
  WHEN (((new.status = 'approved'::driver_status) AND (old.status <> 'approved'::driver_status)))
  EXECUTE FUNCTION trg_referral_reward_on_driver_approved();

RESET ROLE;
