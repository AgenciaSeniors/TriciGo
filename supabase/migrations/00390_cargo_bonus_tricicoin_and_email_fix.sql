-- 00390: Fix the cargo-completion bonus (+5% OTP+photo delivery)
--
-- Two bugs, both surfaced by a "Bonus cargo recibido — TriciGo · 0 TriciCoin" email:
--
-- BUG A (email shows 0): the email was sent by trigger `trg_send_cargo_bonus_email`,
--   an AFTER INSERT ON ledger_transactions whose function read
--   `SELECT le.amount, le.balance_after FROM ledger_entries WHERE transaction_id = NEW.id`.
--   But `apply_cargo_bonus` inserts the ledger_transactions row FIRST (which fires the
--   trigger) and the ledger_entries row AFTER — so at trigger time the SELECT found no
--   rows → COALESCE(NULL,0) → the email always rendered "0 TriciCoin" for amount AND
--   balance, even though the bonus itself was credited correctly.
--
-- BUG B (wrong/invisible wallet): `apply_cargo_bonus` credited `driver_cash` — the
--   deprecated Gen A wallet that the driver app does NOT show (post PR #184 / mig 00300
--   the single live driver wallet is `tricicoin`). So the driver never saw the bonus in
--   their balance. Same silent-drift pattern documented in CLAUDE.md.
--
-- Fix:
--   1. apply_cargo_bonus now credits `tricicoin` and sends the email itself (it already
--      has the real amount + post-credit balance), in a best-effort inner block so an
--      email failure never rolls back the bonus.
--   2. Drop the broken AFTER INSERT trigger + its orphan function.
--   3. Backfill: relocate the existing cargo bonuses sitting on driver_cash to tricicoin
--      (compensating double-entry, idempotent) so drivers actually see them.
--
-- No change to the send-email Edge Function or the `driver_payout` template — the
-- template was fine; only the data was 0 / on the wrong wallet.

-- ── 1) apply_cargo_bonus: credit tricicoin + send the email with real values ──────────
CREATE OR REPLACE FUNCTION public.apply_cargo_bonus(
  p_ride_id uuid,
  p_driver_user_id uuid,
  p_amount_cents integer
)
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

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by, metadata)
  VALUES (v_idempotency_key, 'adjustment', 'posted', 'ride', p_ride_id, 'Bonus cargo +5% (OTP validado + foto delivery)', p_driver_user_id, jsonb_build_object('source', 'cargo_completion_trigger', 'ride_id', p_ride_id))
  RETURNING id INTO v_tx_id;

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

-- ── 2) Drop the broken AFTER-INSERT-on-transactions email trigger + orphan function ───
DROP TRIGGER IF EXISTS trg_send_cargo_bonus_email ON public.ledger_transactions;
DROP FUNCTION IF EXISTS public.send_cargo_bonus_email_from_ledger();

-- ── 3) Backfill: relocate existing cargo bonuses from driver_cash → tricicoin ─────────
-- Compensating double-entry (ledger is immutable — never UPDATE old entries). Idempotent
-- via 'cargo_bonus_relocate:<ride_id>'. No email fires (trigger already dropped above,
-- and the key does not match 'cargo_bonus:%').
DO $backfill$
DECLARE
  rec RECORD;
  v_relocate_key text;
  v_tx_id uuid;
  v_tc_account uuid;
  v_dc_balance integer;
  v_tc_balance integer;
BEGIN
  FOR rec IN
    SELECT lt.reference_id AS ride_id, le.amount AS amt, wa.user_id AS user_id, wa.id AS dc_account
    FROM ledger_transactions lt
    JOIN ledger_entries le ON le.transaction_id = lt.id
    JOIN wallet_accounts wa ON wa.id = le.account_id AND wa.account_type = 'driver_cash'
    WHERE lt.idempotency_key LIKE 'cargo_bonus:%'
      AND le.amount > 0
  LOOP
    v_relocate_key := 'cargo_bonus_relocate:' || rec.ride_id::text;
    IF EXISTS (SELECT 1 FROM ledger_transactions WHERE idempotency_key = v_relocate_key) THEN
      CONTINUE;
    END IF;

    v_tc_account := ensure_wallet_account(rec.user_id, 'tricicoin');

    INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by, metadata)
    VALUES (v_relocate_key, 'adjustment', 'posted', 'ride', rec.ride_id, 'Reubicación bono cargo driver_cash→tricicoin (00390)', rec.user_id, jsonb_build_object('source', '00390_backfill', 'ride_id', rec.ride_id))
    RETURNING id INTO v_tx_id;

    -- Debit driver_cash (reverse the original misplaced credit)
    UPDATE wallet_accounts SET balance = balance - rec.amt, updated_at = NOW() WHERE id = rec.dc_account RETURNING balance INTO v_dc_balance;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, rec.dc_account, -rec.amt, v_dc_balance);

    -- Credit tricicoin (where the bonus should have gone)
    UPDATE wallet_accounts SET balance = balance + rec.amt, updated_at = NOW() WHERE id = v_tc_account RETURNING balance INTO v_tc_balance;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES (v_tx_id, v_tc_account, rec.amt, v_tc_balance);
  END LOOP;
END
$backfill$;
