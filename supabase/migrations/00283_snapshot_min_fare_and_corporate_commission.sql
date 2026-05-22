-- ============================================================
-- Migration 00283: extend pricing snapshot with min_fare + corporate
--                  commission + platform default snapshots
--
-- Follow-up del 00282. El audit posterior reveló 3 gaps que dejaban
-- abierto el mismo patrón "live-read-at-completion" que el 00282 cerró
-- para B1/B2/L2:
--
--   G1 — `min_fare_cup`: el estimate puede aplicar un min_fare distinto
--        al service default (pricing rule peak hour con floor más alto).
--        00282:140 forzaba `v_eff_min_fare := v_svc.min_fare_cup` — el
--        floor del estimate se ignoraba.
--
--   B6 — corporate variable commission (00236): tanto
--        `corporate_accounts.commission_percent` como
--        `platform_config.commission_rate` se releen LIVE en el RPC.
--        Si una empresa o el admin platform cambia la rate mid-trip,
--        el `final_fare_cup` diverge del `estimated_fare_cup` por la
--        misma razón conceptual que B1. Magnitud típica 3-7%.
--
--   G2 — `commission_rate` snapshoteado: el TS antes hardcodeaba 0.15
--        al persistir el estimate. El 00283 lo lee del platform_config
--        en el momento del INSERT (cambio Cambio 2 del followup TS).
--        Esta migración lo lee de vuelta al cobrar.
--
-- Approach: agregar 3 columnas nullable a `ride_pricing_snapshots`
-- (`min_fare`, `corporate_commission_rate`, `default_commission_rate_snapshot`)
-- y redefinir `complete_ride_and_pay` para preferir esos valores cuando
-- existan. Legacy rides sin estos campos → COALESCE al live fallback,
-- comportamiento idéntico al 00282 actual.
--
-- Preserva verbatim del 00282: estimate snapshot lookup, wait charge
-- re-suma (B2), surge desde snapshot (L2), payment dispatch branches
-- (tricicoin / mixed / tropipay / corporate / cash + splits + insurance),
-- caller check (BUG-203).
-- ============================================================

-- ── 1) Schema: 3 nuevas columnas en ride_pricing_snapshots ──
-- IF NOT EXISTS para idempotencia (la migración se aplica una sola vez
-- pero defensivo por si se re-corre en staging).
ALTER TABLE public.ride_pricing_snapshots
  ADD COLUMN IF NOT EXISTS min_fare INTEGER,
  ADD COLUMN IF NOT EXISTS corporate_commission_rate NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS default_commission_rate_snapshot NUMERIC(5,4);

COMMENT ON COLUMN public.ride_pricing_snapshots.min_fare IS
  '00283: min fare floor efectivo en el momento del snapshot. Cuando '
  'snapshot_type=estimate, el RPC complete_ride_and_pay lo usa como '
  'floor del cálculo final en lugar de service_type_configs.min_fare_cup, '
  'que puede haber cambiado mid-trip.';
COMMENT ON COLUMN public.ride_pricing_snapshots.corporate_commission_rate IS
  '00283: corporate_accounts.commission_percent/100 snapshoteado al '
  'crear el ride. NULL para rides no corporativos. El RPC lo usa en '
  'lugar de releer live (cierra B6).';
COMMENT ON COLUMN public.ride_pricing_snapshots.default_commission_rate_snapshot IS
  '00283: platform_config.commission_rate snapshoteado al crear el ride. '
  'El RPC lo usa como base de comparación contra corporate (00236 logic) '
  'y como rate efectivo cuando no hay override. Cierra G2.';

-- ── 2) Redefinir complete_ride_and_pay con los lookups del snapshot ──
CREATE OR REPLACE FUNCTION public.complete_ride_and_pay(
  p_ride_id uuid,
  p_driver_id uuid,
  p_actual_distance_m integer,
  p_actual_duration_s integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_ride RECORD;
  v_svc RECORD;
  v_est RECORD;                       -- 00282: estimate snapshot (or NULL for legacy)
  v_commission_rate NUMERIC;
  v_distance_km NUMERIC;
  v_duration_min NUMERIC;
  v_eff_base_fare INTEGER;
  v_eff_per_km INTEGER;
  v_eff_per_min INTEGER;
  v_eff_min_fare INTEGER;             -- 00283: snapshot > service default
  v_eff_pricing_rule UUID;
  v_wait_charge INTEGER;
  v_raw_fare INTEGER;
  v_fare INTEGER;
  v_final_fare INTEGER;
  v_exchange_rate NUMERIC;
  v_final_fare_trc INTEGER;
  v_commission_amount INTEGER;
  v_driver_earnings INTEGER;
  v_share_token TEXT;
  v_driver_user_id UUID;
  v_customer_account_id UUID;
  v_driver_account_id UUID;
  v_driver_tricicoin_account_id UUID;
  v_platform_account_id UUID;
  v_customer_balance INTEGER;
  v_driver_balance INTEGER;
  v_driver_tricicoin_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_surge NUMERIC;
  v_payment_status TEXT;
  v_split RECORD;
  v_split_amount INTEGER;
  v_split_total INTEGER := 0;
  v_split_account_id UUID;
  v_split_balance INTEGER;
  v_insurance_premium_trc INTEGER := 0;
  v_payment_method_text TEXT;
  v_wallet_amount INTEGER;
  v_cash_amount INTEGER;
  v_default_commission_rate NUMERIC;
  v_corp_commission_rate NUMERIC;
  v_original_final_fare INTEGER;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;

  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found: %', p_ride_id;
  END IF;

  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RAISE EXCEPTION 'Ride % cannot be completed (current: %)', p_ride_id, v_ride.status;
  END IF;

  IF v_ride.driver_id != p_driver_id THEN
    RAISE EXCEPTION 'Driver % is not assigned to ride %', p_driver_id, p_ride_id;
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = p_driver_id;

  IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden: only the assigned driver can complete this ride';
  END IF;

  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type AND is_active = true;
  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active service config for type: %', v_ride.service_type;
  END IF;

  -- ── estimate snapshot lookup (preservado del 00282) ──
  SELECT * INTO v_est
  FROM ride_pricing_snapshots
  WHERE ride_id = p_ride_id AND snapshot_type = 'estimate'
  LIMIT 1;

  -- ── effective rates (00282 + 00283) ──
  -- Preference: driver_custom_rate_cup > estimate snapshot > service default.
  v_eff_base_fare    := COALESCE(v_est.base_fare, v_svc.base_fare_cup);
  v_eff_per_km       := COALESCE(v_ride.driver_custom_rate_cup, v_est.per_km_rate, v_svc.per_km_rate_cup);
  v_eff_per_min      := COALESCE(v_est.per_minute_rate, v_svc.per_minute_rate_cup);
  -- 00283 G1: min_fare del snapshot tiene precedencia sobre el service
  -- default. Si la pricing rule del estimate definió un floor más alto,
  -- el RPC lo respeta.
  v_eff_min_fare     := COALESCE(v_est.min_fare, v_svc.min_fare_cup);
  v_eff_pricing_rule := v_est.pricing_rule_id;

  -- ── surge from snapshot (preservado del 00282 L2) ──
  v_surge := COALESCE(
    NULLIF(v_ride.surge_multiplier, 0),
    v_est.surge_multiplier,
    get_surge_multiplier(v_ride.pickup_location)
  );

  v_distance_km := p_actual_distance_m / 1000.0;
  v_duration_min := p_actual_duration_s / 60.0;

  v_raw_fare := ROUND(
    v_eff_base_fare
    + (v_distance_km * v_eff_per_km)
    + (v_duration_min * v_eff_per_min)
  );
  v_fare := GREATEST(ROUND(v_raw_fare * v_surge), v_eff_min_fare);

  -- ── wait charge integration (preservado del 00282 B2) ──
  PERFORM calculate_wait_charge(p_ride_id);
  SELECT wait_time_charge_cup INTO v_wait_charge FROM rides WHERE id = p_ride_id;

  v_final_fare := GREATEST(v_fare - COALESCE(v_ride.discount_amount_cup, 0), 0)
                + COALESCE(v_wait_charge, 0);

  v_exchange_rate := COALESCE(v_ride.exchange_rate_usd_cup, get_current_exchange_rate());
  v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);

  IF v_ride.insurance_selected = true AND v_ride.insurance_premium_cup > 0 THEN
    v_insurance_premium_trc := cup_to_trc_centavos(v_ride.insurance_premium_cup, v_exchange_rate);
  END IF;

  -- ── 00283 G2: platform default commission con preferencia snapshot ──
  -- El snapshot del estimate (vía Cambio 2 del followup TS) escribe
  -- `default_commission_rate_snapshot` con el valor live de
  -- platform_config al momento de crear. El RPC ahora lo prefiere; si
  -- no existe (legacy ride o snapshot incompleto), cae al live actual
  -- y finalmente al hardcoded 0.15 — comportamiento idéntico al 00282.
  v_default_commission_rate := COALESCE(
    v_est.default_commission_rate_snapshot,
    (SELECT (value #>> '{}')::NUMERIC FROM platform_config WHERE key = 'commission_rate'),
    0.15
  );
  v_commission_rate := v_default_commission_rate;

  -- ── 00236 + 00283 B6: corporate override con snapshot ──
  -- v_corp_commission_rate ahora prefiere el rate snapshoteado al crear
  -- el ride. Si el snapshot no lo trae (legacy o ride no-corporate),
  -- COALESCE cae al live actual y finalmente NULL. La lógica de
  -- comparación contra el default del 00236 se preserva verbatim.
  IF v_ride.corporate_account_id IS NOT NULL THEN
    v_corp_commission_rate := COALESCE(
      v_est.corporate_commission_rate,
      (SELECT commission_percent / 100.0 FROM corporate_accounts WHERE id = v_ride.corporate_account_id)
    );

    IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_default_commission_rate THEN
      v_original_final_fare := v_final_fare;
      v_driver_earnings := v_original_final_fare - ROUND(v_original_final_fare * v_default_commission_rate);
      v_commission_amount := ROUND(v_original_final_fare * v_corp_commission_rate);
      v_final_fare := v_driver_earnings + v_commission_amount;
      v_final_fare_trc := cup_to_trc_centavos(v_final_fare, v_exchange_rate);
      v_commission_rate := v_corp_commission_rate;
    ELSE
      v_commission_amount := ROUND(v_final_fare * v_commission_rate);
      v_driver_earnings := v_final_fare - v_commission_amount;
    END IF;
  ELSE
    v_commission_amount := ROUND(v_final_fare * v_commission_rate);
    v_driver_earnings := v_final_fare - v_commission_amount;
  END IF;
  -- ── end 00236 + 00283 ──

  v_share_token := encode(gen_random_bytes(12), 'hex');

  v_payment_method_text := v_ride.payment_method::TEXT;

  IF v_payment_method_text = 'tropipay' THEN
    v_payment_status := 'pending';
  ELSE
    v_payment_status := 'not_applicable';
  END IF;

  UPDATE rides SET
    status = 'completed',
    completed_at = NOW(),
    final_fare_cup = v_final_fare,
    final_fare_trc = v_final_fare_trc,
    exchange_rate_usd_cup = v_exchange_rate,
    actual_distance_m = p_actual_distance_m,
    actual_duration_s = p_actual_duration_s,
    share_token = v_share_token,
    payment_status = v_payment_status
  WHERE id = p_ride_id;

  -- 00283: final snapshot también persiste min_fare + ambas commission
  -- rates para auditoría completa side-by-side con el estimate.
  INSERT INTO ride_pricing_snapshots (
    ride_id, snapshot_type, base_fare, per_km_rate, per_minute_rate,
    distance_m, duration_s, surge_multiplier, subtotal,
    commission_rate, commission_amount, total, pricing_rule_id,
    exchange_rate_usd_cup, total_trc,
    min_fare, corporate_commission_rate, default_commission_rate_snapshot
  ) VALUES (
    p_ride_id, 'final', v_eff_base_fare, v_eff_per_km,
    v_eff_per_min, p_actual_distance_m, p_actual_duration_s,
    v_surge, v_fare, v_commission_rate, v_commission_amount, v_final_fare, v_eff_pricing_rule,
    v_exchange_rate, v_final_fare_trc,
    v_eff_min_fare, v_corp_commission_rate, v_default_commission_rate
  );

  -- ── Payment dispatch — preserved verbatim from 00282 / 00247. ──

  IF v_payment_method_text = 'tricicoin' THEN
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

    IF v_ride.is_split THEN
      FOR v_split IN
        SELECT * FROM ride_splits WHERE ride_id = p_ride_id AND accepted_at IS NOT NULL ORDER BY created_at
      LOOP
        v_split_amount := ROUND(v_final_fare_trc * v_split.share_pct / 100);
        v_split_total := v_split_total + v_split_amount;
        v_split_account_id := ensure_wallet_account(v_split.user_id, 'customer_cash');
        SELECT balance INTO v_split_balance FROM wallet_accounts WHERE id = v_split_account_id FOR UPDATE;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'ride_split_payment:' || p_ride_id::TEXT || ':' || v_split.user_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id, 'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8), v_split.user_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_split_account_id, -v_split_amount, v_split_balance - v_split_amount);
        UPDATE wallet_accounts SET balance = balance - v_split_amount WHERE id = v_split_account_id;

        UPDATE ride_splits SET amount_trc = v_split_amount, payment_status = 'paid', paid_at = NOW() WHERE id = v_split.id;
      END LOOP;

      DECLARE v_requester_amount INTEGER;
      BEGIN
        v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
        v_requester_amount := v_final_fare_trc - v_split_total;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'ride_split_payment:' || p_ride_id::TEXT || ':' || v_ride.customer_id::TEXT,
          'ride_payment', 'posted', 'ride', p_ride_id, 'Pago parcial viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_requester_amount, v_customer_balance - v_requester_amount);
        UPDATE wallet_accounts SET balance = balance - v_requester_amount WHERE id = v_customer_account_id;
      END;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'ride_driver_credit:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Ganancia conductor viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;

    ELSE
      v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'ride_payment:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Pago de viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_final_fare_trc, v_customer_balance - v_final_fare_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

      UPDATE wallet_accounts SET balance = balance - v_final_fare_trc WHERE id = v_customer_account_id;
      UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

      IF v_insurance_premium_trc > 0 THEN
        SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
        SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

        INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
        VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
          'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
        RETURNING id INTO v_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

        UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
        UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
      END IF;
    END IF;

  ELSIF v_payment_method_text = 'mixed' THEN
    v_wallet_amount := ROUND(v_final_fare_trc * COALESCE(v_ride.wallet_ratio, 0));
    v_cash_amount := v_final_fare_trc - v_wallet_amount;

    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    v_wallet_amount := LEAST(GREATEST(v_wallet_amount, 0), v_customer_balance);
    v_cash_amount := v_final_fare_trc - v_wallet_amount;

    UPDATE rides SET
      wallet_amount_cup = v_wallet_amount,
      cash_amount_cup = v_cash_amount
    WHERE id = p_ride_id;

    IF v_wallet_amount > 0 THEN
      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'mixed_wallet_debit:' || p_ride_id::TEXT,
        'ride_payment', 'posted', 'ride', p_ride_id, 'Pago mixto (wallet) viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_wallet_amount, v_customer_balance - v_wallet_amount);

      UPDATE wallet_accounts SET balance = balance - v_wallet_amount WHERE id = v_customer_account_id;
    END IF;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'mixed_driver_credit:' || p_ride_id::TEXT,
      'ride_payment', 'posted', 'ride', p_ride_id, 'Ganancia conductor mixto viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, v_driver_earnings, v_driver_balance + v_driver_earnings);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, -v_commission_amount, v_driver_tricicoin_balance - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_tricicoin_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    IF v_insurance_premium_trc > 0 THEN
      SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id;
      SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
        'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_ride.customer_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_customer_account_id, -v_insurance_premium_trc, v_customer_balance - v_insurance_premium_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

      UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_customer_account_id;
      UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
    END IF;

  ELSIF v_payment_method_text = 'tropipay' THEN
    NULL;

  ELSIF v_payment_method_text = 'corporate' THEN
    NULL;

  ELSE
    -- Cash branch (BUG-210 + BUG-211 fix from 00223).
    v_driver_tricicoin_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');
    SELECT balance INTO v_driver_tricicoin_balance FROM wallet_accounts WHERE id = v_driver_tricicoin_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'cash_commission:' || p_ride_id::TEXT,
      'commission', 'posted', 'ride', p_ride_id, 'Comision viaje efectivo #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_tricicoin_account_id, -v_commission_amount, v_driver_tricicoin_balance - v_commission_amount);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_commission_amount WHERE id = v_driver_tricicoin_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    IF v_insurance_premium_trc > 0 THEN
      v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
      SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id;
      SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

      INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
      VALUES (gen_random_uuid(), 'insurance_premium:' || p_ride_id::TEXT,
        'insurance_premium', 'posted', 'ride', p_ride_id, 'Prima seguro viaje #' || LEFT(p_ride_id::TEXT, 8), v_driver_user_id)
      RETURNING id INTO v_txn_id;

      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_driver_account_id, -v_insurance_premium_trc, v_driver_balance - v_insurance_premium_trc);
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      VALUES (v_txn_id, v_platform_account_id, v_insurance_premium_trc, v_platform_balance + v_insurance_premium_trc);

      UPDATE wallet_accounts SET balance = balance - v_insurance_premium_trc WHERE id = v_driver_account_id;
      UPDATE wallet_accounts SET balance = balance + v_insurance_premium_trc WHERE id = v_platform_account_id;
    END IF;
  END IF;

  UPDATE driver_profiles SET total_rides_completed = total_rides_completed + 1 WHERE id = p_driver_id;

  RETURN jsonb_build_object(
    'final_fare_cup', v_final_fare,
    'final_fare_trc', v_final_fare_trc,
    'exchange_rate_usd_cup', v_exchange_rate,
    'commission_amount', v_commission_amount,
    'driver_earnings', v_driver_earnings,
    'commission_rate', v_commission_rate,
    'is_corporate_discounted', (v_corp_commission_rate IS NOT NULL),
    'payment_method', v_ride.payment_method,
    'share_token', v_share_token,
    'surge_multiplier', v_surge,
    'driver_custom_rate_cup', v_ride.driver_custom_rate_cup,
    'payment_status', v_payment_status,
    'insurance_selected', v_ride.insurance_selected,
    'insurance_premium_cup', v_ride.insurance_premium_cup,
    'insurance_premium_trc', v_insurance_premium_trc,
    'wallet_amount_cup', COALESCE(v_wallet_amount, 0),
    'cash_amount_cup', COALESCE(v_cash_amount, 0),
    'wait_time_charge_cup', COALESCE(v_wait_charge, 0),
    'pricing_rule_id', v_eff_pricing_rule,
    'estimate_snapshot_present', (v_est.ride_id IS NOT NULL),
    -- 00283: surface effective min_fare + commission rates usados al cobrar.
    -- Útil para debugging: si min_fare_used != service default, sabemos
    -- que el snapshot ganó. Para corporate, expone tanto el rate efectivo
    -- como el default para entender la conversión del 00236.
    'min_fare_used', v_eff_min_fare,
    'corporate_commission_rate_used', v_corp_commission_rate,
    'default_commission_rate_used', v_default_commission_rate
  );
END;
$$;

COMMENT ON FUNCTION public.complete_ride_and_pay(uuid, uuid, integer, integer) IS
  '00283: snapshot-aware completion extendido. Sumado al 00282 (estimate '
  'rates / surge / wait charge / pricing_rule_id), ahora también prefiere '
  'el min_fare del snapshot (G1) y los commission rates corporate+default '
  'snapshoteados (B6/G2). Cierra el patrón "live-read-at-completion" en '
  'todos los rates conocidos. Backward compatible con rides legacy via '
  'COALESCE a service_type_configs / platform_config / corporate_accounts '
  'live. Preserva verbatim caller check (BUG-203), lógica de comparación '
  '00236 (corporate < default → corporate gana), y todos los payment '
  'dispatch branches (tricicoin / mixed / tropipay / corporate / cash + '
  'splits + insurance).';
