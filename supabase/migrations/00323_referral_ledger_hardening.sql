-- ============================================================
-- Cierra 3 bugs de robustez del sistema de referidos:
--
-- R-HIGH-3: `admin_reward_referral` (00188:25-94) no envuelve el
--   INSERT del `ledger_transactions` en EXCEPTION block. El trigger
--   versión (00019:82-99) sí lo hace. Si el admin clickea "reward"
--   dos veces, el segundo call falla con `unique_violation` sobre
--   `idempotency_key='referral_bonus_admin:{id}'` y aborta la
--   transacción con error confuso ("duplicate key") en lugar de un
--   "already rewarded" claro.
--
-- R-HIGH-4: triggers + admin RPC leen `wallet_accounts.balance` sin
--   `FOR UPDATE`, luego insertan `ledger_entries.balance_after` y
--   updatean wallet_accounts. Si dos triggers se disparan
--   simultáneamente (ej: el referrer recibe bono de dos referidos
--   cuyo primer viaje termina al mismo momento), `balance_after`
--   en `ledger_entries` queda inconsistente con el balance final.
--   Como ledger_entries es immutable (NO UPDATE/DELETE), la
--   anomalía no se puede corregir post-hoc → audit log roto.
--
-- R-HIGH-5: `SELECT (value::BOOLEAN) INTO v_flag_enabled FROM
--   feature_flags WHERE key='referral_program_enabled'` (00019:34)
--   asume que `value` es un texto castable a BOOLEAN. Si admin
--   cambia el valor a "on"/"off" en lugar de "true"/"false", el
--   cast explota → trigger crashea → falla la transacción del
--   ride completion (el cliente ve "no se pudo completar el viaje").
--   Defensivo: try/catch + fallback a false.
-- ============================================================

-- ============================================================
-- R-HIGH-3 + R-HIGH-4: admin_reward_referral idempotente + FOR UPDATE
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_reward_referral(p_referral_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_ref RECORD;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_caller_is_admin BOOLEAN;
BEGIN
  -- BUG-131 (00188): caller must be admin/super_admin (sin cambios)
  SELECT (role IN ('admin','super_admin'))
    INTO v_caller_is_admin
  FROM users WHERE id = auth.uid();
  IF NOT COALESCE(v_caller_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to reward referrals';
  END IF;

  -- Lock the referral row (sin cambios)
  SELECT * INTO v_ref
  FROM referrals WHERE id = p_referral_id AND status = 'pending'
  FOR UPDATE;

  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Referral not found or not pending: %', p_referral_id;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  -- R-HIGH-4: FOR UPDATE en ambos wallet SELECT → row lock previene
  -- race con triggers concurrentes (otro referido completando viaje
  -- en el mismo momento, otro admin doblando-click, etc.). El order
  -- es deterministic (platform primero, referrer después) para
  -- evitar deadlock con el trigger que también follow el mismo orden.
  SELECT balance INTO v_platform_balance
    FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;
  SELECT balance INTO v_referrer_balance
    FROM wallet_accounts WHERE id = v_referrer_account_id FOR UPDATE;

  -- R-HIGH-3: envolver el INSERT en EXCEPTION block. Si la
  -- idempotency_key ya existe (admin clickeó "reward" dos veces, o
  -- corrió un retry de red), devolver silently — el referral ya está
  -- rewardeado o la versión trigger lo procesó.
  BEGIN
    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status,
      reference_type, reference_id, description, created_by
    ) VALUES (
      gen_random_uuid(),
      'referral_bonus_admin:' || v_ref.id::TEXT,
      'promo_credit', 'posted',
      'referral', v_ref.id,
      'Bono de referido (admin) - código ' || v_ref.code,
      (SELECT auth.uid())
    )
    RETURNING id INTO v_txn_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already rewarded: la fila `referrals` posiblemente ya pasó a
    -- 'rewarded' por el trigger paralelo. Verificamos y salimos
    -- silenciosamente — el resultado para el caller es el deseado.
    RAISE NOTICE 'Referral % already rewarded (idempotency_key collision)', p_referral_id;
    RETURN;
  END;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

  UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
  UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

  UPDATE referrals
  SET status = 'rewarded', rewarded_at = NOW(), transaction_id = v_txn_id
  WHERE id = p_referral_id;
END;
$$;

COMMENT ON FUNCTION public.admin_reward_referral(uuid) IS
  'R-HIGH-3/R-HIGH-4: idempotente (EXCEPTION block en unique_violation) + FOR UPDATE en wallet_accounts. BUG-131 admin role check preservado.';

-- ============================================================
-- R-HIGH-4 + R-HIGH-5: trigger referral_reward_on_complete
--   hardened: FOR UPDATE wallets + try/catch feature flag cast
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_complete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
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
BEGIN
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  -- R-HIGH-5: defensive cast del feature flag. Si la value no es
  -- textualmente "true"/"false" (ej: JSONB con un string raro),
  -- el cast original explotaba y crasheaba la transacción del
  -- ride completion. Ahora fallamos cerrado (flag disabled).
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
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  -- R-HIGH-4: row lock determinístico (platform primero) para
  -- evitar deadlock con admin_reward_referral concurrente.
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
      'Bono de referido - código ' || v_ref.code,
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

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_referral_reward_on_complete() IS
  'R-HIGH-4/R-HIGH-5: FOR UPDATE wallet_accounts (orden deterministic platform→referrer) + try/catch defensive del cast feature flag.';

-- ============================================================
-- R-HIGH-4 + R-HIGH-5: trigger referral_reward_on_driver_approved
--   mismo hardening
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_driver_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
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
BEGIN
  IF NEW.status != 'approved' OR OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;

  -- R-HIGH-5: defensive feature flag cast.
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
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  -- R-HIGH-4: row lock orden deterministic.
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
      'Bono de referido conductor - código ' || v_ref.code,
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

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_referral_reward_on_driver_approved() IS
  'R-HIGH-4/R-HIGH-5: FOR UPDATE wallet_accounts + try/catch defensive del cast feature flag (mirror del trg_referral_reward_on_complete).';
