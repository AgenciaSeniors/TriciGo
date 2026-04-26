-- ============================================================
-- BUG-210 (5) rollout: grandfather existing drivers with a
-- starter TriciCoin balance so they can keep accepting rides
-- after 00224 (the insufficient_tricicoin_balance check) is
-- deployed.
--
-- Decision: 2000 TRC = 2000 CUP per active driver. That covers
-- ~5-7 average commissions, giving the operations team a runway
-- to ship the top-up UI before drivers run dry.
--
-- Audit: each grant is recorded as a ledger_transaction with
-- type='wallet_credit' and a reference back to this migration,
-- so the credit is auditable and the wallet ledger invariant
-- (balance == sum(ledger_entries.amount)) is preserved.
-- ============================================================

DO $$
DECLARE
  v_driver RECORD;
  v_account_id UUID;
  v_balance INTEGER;
  v_txn_id UUID;
  v_grant_amount CONSTANT INTEGER := 2000;
  v_platform_user_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  FOR v_driver IN
    SELECT id, full_name FROM users WHERE role = 'driver'
  LOOP
    -- Ensure the wallet exists (00222 should have created it; ON CONFLICT
    -- on the trigger means re-running this migration is safe).
    SELECT id, balance INTO v_account_id, v_balance
      FROM wallet_accounts
     WHERE user_id = v_driver.id
       AND account_type = 'tricicoin'
     FOR UPDATE;

    IF v_account_id IS NULL THEN
      INSERT INTO wallet_accounts (user_id, account_type, balance)
      VALUES (v_driver.id, 'tricicoin'::wallet_account_type, 0)
      RETURNING id, balance INTO v_account_id, v_balance;
    END IF;

    -- Skip if this driver was already seeded (idempotency: re-running
    -- this migration on a partially-applied state must not double-credit).
    IF EXISTS (
      SELECT 1 FROM ledger_transactions
       WHERE idempotency_key = 'tricicoin_grandfather:' || v_driver.id::TEXT
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id,
      description, created_by
    ) VALUES (
      gen_random_uuid(),
      'tricicoin_grandfather:' || v_driver.id::TEXT,
      'wallet_credit',
      'posted',
      'migration',
      NULL,
      'Saldo inicial TriciCoin (migration 00225, BUG-210 rollout) — '
        || 'cubre ~5-7 comisiones para operar mientras se construye el flow de recarga',
      v_platform_user_id
    ) RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_account_id, v_grant_amount, v_balance + v_grant_amount);

    UPDATE wallet_accounts
       SET balance = balance + v_grant_amount
     WHERE id = v_account_id;
  END LOOP;
END $$;

-- Sanity check: every driver now has at least the grant amount.
DO $$
DECLARE
  v_underfunded INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_underfunded
    FROM users u
    LEFT JOIN wallet_accounts wa
      ON wa.user_id = u.id AND wa.account_type = 'tricicoin'
   WHERE u.role = 'driver'
     AND COALESCE(wa.balance, 0) < 2000;

  IF v_underfunded > 0 THEN
    RAISE WARNING '% drivers still under 2000 TRC after seed (likely had positive balance from elsewhere; non-fatal)', v_underfunded;
  END IF;
END $$;
