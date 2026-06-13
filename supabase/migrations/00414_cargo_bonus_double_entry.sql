-- 00414_cargo_bonus_double_entry.sql
-- ============================================================================
-- Fix: the cargo completion bonus (+5% to the driver for a delivery with OTP +
-- photo) violated double-entry bookkeeping — apply_cargo_bonus credited the
-- driver's tricicoin wallet WITHOUT debiting any counterparty, creating
-- TriciCoin out of thin air. The rest of the system keeps strict double-entry
-- (e.g. admin_reward_referral debits platform_promotions). The cargo bonus did
-- not, so SUM(all ledger_entries) drifts to +bonus after each cargo delivery,
-- and the incentive cost is never recorded against platform_promotions.
--
-- The money-health-check DRIFT detector is per-account (balance = SUM(entries
-- for that account)), which still held (the driver wallet rose in both balance
-- and entries). The imbalance is GLOBAL, which no detector checked.
--
-- Latent today (prod was wiped → 0 cargo bonuses, ledger_transactions empty),
-- but the first completed cargo delivery (OTP validated + photo uploaded)
-- would trigger it. Since TriciCoin is 1:1 CUP, minting unbacked TRC and not
-- recording the spend is a real accounting defect for a payments platform.
--
-- Fix: debit platform_promotions for the bonus (same pattern as
-- admin_reward_referral) so the bonus is a balanced two-entry transaction.
-- platform_promotions may go negative (no floor), like the referral, recording
-- the accumulated cargo-incentive spend. Body reproduced verbatim from the live
-- prod function; only the platform debit (two declared vars + the debit
-- update/entry) is new — idempotency, the inline best-effort email, the
-- defensive handler and the jsonb return are unchanged.
-- ============================================================================

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

  -- Idempotent: one bonus per ride.
  SELECT id INTO v_existing_tx_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key LIMIT 1;
  IF v_existing_tx_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'transaction_id', v_existing_tx_id, 'message', 'bonus already applied for this ride');
  END IF;

  -- BUG B fix: credit the live driver wallet (tricicoin), not the deprecated driver_cash.
  v_account_id := ensure_wallet_account(p_driver_user_id, 'tricicoin');

  -- 00414: double-entry — the platform funds the incentive from platform_promotions
  -- (may go negative, like admin_reward_referral). Without this debit the bonus
  -- minted unbacked TriciCoin and the spend went unrecorded.
  v_platform_account_id := ensure_wallet_account('00000000-0000-0000-0000-000000000001', 'platform_promotions');
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by, metadata)
  VALUES (v_idempotency_key, 'adjustment', 'posted', 'ride', p_ride_id, 'Bonus cargo +5% (OTP validado + foto delivery)', p_driver_user_id, jsonb_build_object('source', 'cargo_completion_trigger', 'ride_id', p_ride_id))
  RETURNING id INTO v_tx_id;

  -- Debit the platform promotions wallet (the funding side of the bonus).
  UPDATE wallet_accounts SET balance = balance - p_amount_cents, updated_at = NOW() WHERE id = v_platform_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, v_platform_account_id, -p_amount_cents, v_platform_balance - p_amount_cents);

  -- Credit the driver's tricicoin wallet (the receiving side).
  UPDATE wallet_accounts SET balance = balance + p_amount_cents, updated_at = NOW() WHERE id = v_account_id RETURNING balance INTO v_new_balance;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, v_account_id, p_amount_cents, v_new_balance);

  -- BUG A fix: send the email HERE, with the real amount + post-credit balance.
  -- Best-effort: an email failure must never roll back the bonus, so it has its
  -- own sub-block (the outer EXCEPTION handler would otherwise undo the inserts).
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
$function$;
