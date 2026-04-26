-- ============================================================
-- BUG-211 (8c) backfill: correct historical commission undercharge.
--
-- Pre-fix (migration 00100) `complete_ride_and_pay` computed:
--   v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate)
-- and debited that integer from the driver's `driver_cash` (CUP)
-- wallet. Because TRC ≈ CUP / exchange_rate (~5.3), the actual
-- charge was ~2.83% of the fare, not the configured 15%.
--
-- This migration walks every completed ride where the snapshot's
-- commission_amount is suspiciously low (< 10% of final_fare_cup),
-- computes what the commission *should* have been
-- (final_fare_cup × commission_rate, in CUP), and records the
-- delta as ledger entries:
--   - debit  driver_cash       by  delta
--   - credit platform_revenue  by  delta
--
-- Both operations are atomic per-ride. Each ride gets its own
-- ledger_transaction with idempotency_key='backfill_8c:<ride_id>'
-- so re-running this migration is safe.
--
-- The original snapshot rows are NOT mutated — they remain a
-- historical record of the bug. Going forward (post-00223),
-- snapshot.commission_amount is in CUP and will agree with the
-- ledger automatically.
-- ============================================================

DO $$
DECLARE
  v_ride RECORD;
  v_correct_commission INTEGER;
  v_stored_commission INTEGER;
  v_delta INTEGER;
  v_driver_user_id UUID;
  v_driver_account_id UUID;
  v_driver_balance INTEGER;
  v_platform_account_id UUID;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  v_count INTEGER := 0;
  v_total_delta INTEGER := 0;
BEGIN
  -- Pick the platform_revenue account (singleton).
  SELECT id, balance INTO v_platform_account_id, v_platform_balance
    FROM wallet_accounts
   WHERE user_id = v_platform_user_id
     AND account_type = 'platform_revenue'
   FOR UPDATE;

  IF v_platform_account_id IS NULL THEN
    -- shouldn't happen, but provision if missing
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (v_platform_user_id, 'platform_revenue', 0)
    RETURNING id, balance INTO v_platform_account_id, v_platform_balance;
  END IF;

  FOR v_ride IN
    SELECT
      r.id AS ride_id,
      r.driver_id,
      r.final_fare_cup,
      rps.commission_amount AS stored_commission,
      rps.commission_rate
    FROM rides r
    JOIN ride_pricing_snapshots rps
      ON rps.ride_id = r.id AND rps.snapshot_type = 'final'
    WHERE r.status = 'completed'
      AND r.final_fare_cup > 0
      AND rps.commission_amount IS NOT NULL
      AND rps.commission_rate IS NOT NULL
      -- Only fix rides where the stored commission is < 10% of fare,
      -- i.e. the TRC unit-mismatch bug. Rides post-00223 will have
      -- ~15% so they're skipped here.
      AND (rps.commission_amount::numeric / r.final_fare_cup) < 0.10
  LOOP
    v_correct_commission := ROUND(v_ride.final_fare_cup * v_ride.commission_rate)::INTEGER;
    v_stored_commission  := v_ride.stored_commission;
    v_delta              := v_correct_commission - v_stored_commission;

    IF v_delta <= 0 THEN
      CONTINUE; -- no-op or driver was over-charged (shouldn't happen)
    END IF;

    -- Idempotency: skip if already backfilled.
    IF EXISTS (
      SELECT 1 FROM ledger_transactions
       WHERE idempotency_key = 'backfill_8c:' || v_ride.ride_id::TEXT
    ) THEN
      CONTINUE;
    END IF;

    -- Resolve driver user + cash account
    SELECT user_id INTO v_driver_user_id
      FROM driver_profiles
     WHERE id = v_ride.driver_id;

    IF v_driver_user_id IS NULL THEN
      CONTINUE; -- orphaned ride, skip
    END IF;

    SELECT id, balance INTO v_driver_account_id, v_driver_balance
      FROM wallet_accounts
     WHERE user_id = v_driver_user_id
       AND account_type = 'driver_cash'
     FOR UPDATE;

    IF v_driver_account_id IS NULL THEN
      CONTINUE; -- driver has no cash wallet, skip
    END IF;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id,
      description, created_by
    ) VALUES (
      gen_random_uuid(),
      'backfill_8c:' || v_ride.ride_id::TEXT,
      'commission',
      'posted',
      'ride',
      v_ride.ride_id,
      'Backfill BUG-211: comisión histórica subcobrada. '
        || 'Stored ' || v_stored_commission || ' CUP, debió ser '
        || v_correct_commission || ' CUP, delta ' || v_delta || ' CUP.',
      v_platform_user_id
    ) RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_account_id, -v_delta, v_driver_balance - v_delta);
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, v_delta, v_platform_balance + v_delta);

    UPDATE wallet_accounts SET balance = balance - v_delta WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_delta WHERE id = v_platform_account_id;

    -- Refresh local cache for the next iteration.
    v_driver_balance := v_driver_balance - v_delta;
    v_platform_balance := v_platform_balance + v_delta;
    v_count := v_count + 1;
    v_total_delta := v_total_delta + v_delta;
  END LOOP;

  RAISE NOTICE 'BUG-211 backfill: % rides corrected, % CUP recovered to platform_revenue', v_count, v_total_delta;
END $$;
