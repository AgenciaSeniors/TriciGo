-- ============================================================
-- BUG-213 follow-up to 00227:
-- 00227 Part A's UPDATE users.role triggered the 00222
-- `users_ensure_tricicoin_wallet` trigger BEFORE 00227 Part B
-- got to grant the 2000 starter balance. The trigger created
-- the wallet with balance=0 via ON CONFLICT DO NOTHING. Then
-- Part B's "WHERE wa.id IS NULL" found no rows and skipped the
-- grant, leaving these orphan drivers at balance=0 — which
-- still fails the accept_ride_v2 commission check.
--
-- This migration re-iterates and grants +2000 to any approved
-- driver who:
--   • has a tricicoin wallet (any balance)
--   • has NO `tricicoin_grandfather:` ledger entry from 00225
--   • has NO `tricicoin_orphan_grandfather:` ledger entry from 00227
--
-- The dual NOT-EXISTS check makes this idempotent: re-running
-- never double-credits.
-- ============================================================

DO $$
DECLARE
  v_user RECORD;
  v_account_id UUID;
  v_balance INTEGER;
  v_txn_id UUID;
  v_grant_amount CONSTANT INTEGER := 2000;
  v_platform_user_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  v_count INTEGER := 0;
BEGIN
  FOR v_user IN
    SELECT DISTINCT dp.user_id
    FROM driver_profiles dp
    JOIN wallet_accounts wa
      ON wa.user_id = dp.user_id AND wa.account_type = 'tricicoin'
    WHERE dp.status = 'approved'
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions
         WHERE idempotency_key = 'tricicoin_grandfather:' || dp.user_id::TEXT
      )
      AND NOT EXISTS (
        SELECT 1 FROM ledger_transactions
         WHERE idempotency_key = 'tricicoin_orphan_grandfather:' || dp.user_id::TEXT
      )
  LOOP
    SELECT id, balance INTO v_account_id, v_balance
      FROM wallet_accounts
     WHERE user_id = v_user.user_id AND account_type = 'tricicoin'
     FOR UPDATE;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id,
      description, created_by
    ) VALUES (
      gen_random_uuid(),
      'tricicoin_orphan_grandfather:' || v_user.user_id::TEXT,
      'adjustment', 'posted', 'migration', NULL,
      'Saldo inicial TriciCoin (00228 follow-up de 00227 Part B): wallet ya existía con 0 por trigger 00222 al cambiar role',
      v_platform_user_id
    ) RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_account_id, v_grant_amount, v_balance + v_grant_amount);

    UPDATE wallet_accounts SET balance = balance + v_grant_amount WHERE id = v_account_id;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'BUG-213 follow-up: granted +2000 TRC to % missed orphans', v_count;
END $$;
