-- ============================================================
-- BUG-213 (Issue B post-v1.1.14): drivers approved en
-- driver_profiles pero con users.role != 'driver' no estaban
-- recibiendo wallet `tricicoin` por mi seed (00225) ni mi
-- trigger (00222), porque ambos condicionaban WHERE role='driver'.
--
-- El usuario reportó: el driver `ff15f73a-9913-4b65-b569-7e9065387663`
-- tiene driver_profiles.status='approved' (aprobado el 25 abr 2026)
-- pero users.role='customer'. Sin wallet tricicoin, mi
-- driver_can_afford_commission() (00224) ve 0 → reject con
-- "insufficient_balance: necesita 1825 TRC".
--
-- Esta migration cura el síntoma con una doble corrección
-- (decisión del usuario):
--
--   A. UPDATE users.role='driver' para CADA approved driver con
--      role distinto a driver. Idempotente (NOOP si 00143 ya los
--      cubrió, pero los nuevos approves post-00143 quedan fixed).
--
--   B. INSERT wallet_accounts (tricicoin, balance=2000) para CADA
--      approved driver sin wallet. Audit via ledger_transactions
--      con idempotency_key 'tricicoin_orphan_grandfather:<user_id>'
--      — re-ejecutar la migration NO duplica el grant.
--
--   C. Trigger nuevo `dp_ensure_driver_role_and_tricicoin`:
--      AFTER INSERT OR UPDATE OF status ON driver_profiles
--      WHEN NEW.status='approved'
--      → asegura users.role='driver' + wallet tricicoin (balance=0,
--        sin grant; el seed grandfather aplica solo a pre-existentes,
--        nuevos drivers parten en 0 y deben recargar).
--
-- NO incluido (out of scope): la causa raíz de por qué el flow de
-- approval no actualiza users.role. Tracking ticket separado.
-- ============================================================

-- ─── Part A: backfill role ───────────────────────────────────
DO $$
DECLARE
  v_promoted INTEGER;
BEGIN
  WITH updated AS (
    UPDATE users
    SET role = 'driver'
    WHERE id IN (
      SELECT user_id FROM driver_profiles WHERE status = 'approved'
    )
      AND role <> 'driver'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_promoted FROM updated;

  RAISE NOTICE 'BUG-213 Part A: promoted % users with approved driver_profiles to role=driver', v_promoted;
END $$;

-- ─── Part B: backfill wallet for approved drivers without one ───
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
    -- Every approved driver who doesn't already have a tricicoin wallet
    SELECT DISTINCT dp.user_id
    FROM driver_profiles dp
    LEFT JOIN wallet_accounts wa
      ON wa.user_id = dp.user_id AND wa.account_type = 'tricicoin'
    WHERE dp.status = 'approved'
      AND wa.id IS NULL
  LOOP
    -- Create the wallet (balance starts 0; the grant adds 2000 below)
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (v_user.user_id, 'tricicoin'::wallet_account_type, 0)
    RETURNING id, balance INTO v_account_id, v_balance;

    -- Skip the grant if a previous run on this user already granted
    -- (idempotency under repeat-apply scenarios)
    IF EXISTS (
      SELECT 1 FROM ledger_transactions
       WHERE idempotency_key = 'tricicoin_orphan_grandfather:' || v_user.user_id::TEXT
    ) THEN
      CONTINUE;
    END IF;

    -- Grant the 2000 starter balance with full ledger audit
    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id,
      description, created_by
    ) VALUES (
      gen_random_uuid(),
      'tricicoin_orphan_grandfather:' || v_user.user_id::TEXT,
      'adjustment', 'posted', 'migration', NULL,
      'Saldo inicial TriciCoin (migration 00227, BUG-213) — ' ||
        'driver tenía driver_profiles.approved pero faltaba wallet por mismatch users.role',
      v_platform_user_id
    ) RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_account_id, v_grant_amount, v_balance + v_grant_amount);

    UPDATE wallet_accounts SET balance = balance + v_grant_amount WHERE id = v_account_id;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'BUG-213 Part B: backfilled tricicoin wallet (+2000) for % orphan approved drivers', v_count;
END $$;

-- ─── Part C: trigger to keep both invariants on future approvals ─
-- Fires when a driver_profiles row is created with status='approved'
-- OR when an existing row's status changes to 'approved'. Ensures:
--   • users.role = 'driver' (mirrors 00143 Part A but for new approves)
--   • a tricicoin wallet exists for the user (balance=0; no grant —
--     post-launch drivers must recharge themselves)
CREATE OR REPLACE FUNCTION ensure_driver_role_and_tricicoin_on_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    -- Ensure users.role = 'driver'
    UPDATE users
       SET role = 'driver'
     WHERE id = NEW.user_id
       AND role <> 'driver';

    -- Ensure tricicoin wallet exists (balance 0 for new approves;
    -- the seed grandfather only applies to drivers existing pre-00227)
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.user_id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dp_ensure_driver_role_and_tricicoin ON driver_profiles;

CREATE TRIGGER dp_ensure_driver_role_and_tricicoin
AFTER INSERT OR UPDATE OF status ON driver_profiles
FOR EACH ROW
EXECUTE FUNCTION ensure_driver_role_and_tricicoin_on_approval();

COMMENT ON FUNCTION ensure_driver_role_and_tricicoin_on_approval() IS
  'BUG-213 (Issue B post-v1.1.14): on approval (INSERT or UPDATE to '
  'status=approved), keeps users.role=driver and wallet_accounts.tricicoin '
  'in sync. Replaces the conditional behavior of the old user-role-only '
  'trigger from 00222 which missed approved drivers whose users.role '
  'persisted as `customer`.';
