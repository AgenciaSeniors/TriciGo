-- ============================================================
-- BUG-210 (5): provision a `tricicoin` wallet for every existing
-- driver and add a trigger so future drivers get one automatically.
--
-- This migration is split from the enum-add (00221) because
-- Postgres requires the ALTER TYPE to commit before the new value
-- can be referenced.
--
-- After this runs:
--   - Every user with role='driver' has exactly one wallet_account
--     of type='tricicoin' with balance=0.
--   - The trigger `wa_create_tricicoin_for_driver` mirrors the
--     existing pattern that provisions `driver_cash` on driver
--     creation/promotion.
-- ============================================================

-- 1. Backfill existing drivers
INSERT INTO wallet_accounts (user_id, account_type, balance)
SELECT u.id, 'tricicoin'::wallet_account_type, 0
FROM users u
WHERE u.role = 'driver'
  AND NOT EXISTS (
    SELECT 1 FROM wallet_accounts wa
    WHERE wa.user_id = u.id AND wa.account_type = 'tricicoin'
  );

-- 2. Trigger: auto-provision tricicoin wallet on driver creation
--    and on role change to/from driver.
CREATE OR REPLACE FUNCTION ensure_tricicoin_wallet_for_driver()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.role = 'driver' THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance)
    VALUES (NEW.id, 'tricicoin'::wallet_account_type, 0)
    ON CONFLICT (user_id, account_type) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_ensure_tricicoin_wallet ON users;

CREATE TRIGGER users_ensure_tricicoin_wallet
AFTER INSERT OR UPDATE OF role ON users
FOR EACH ROW
EXECUTE FUNCTION ensure_tricicoin_wallet_for_driver();

COMMENT ON FUNCTION ensure_tricicoin_wallet_for_driver() IS
  'BUG-210 (5): keeps wallet_accounts.tricicoin in sync with '
  'users.role=driver. Idempotent via ON CONFLICT — safe to fire '
  'on UPDATE even when the row already has a tricicoin wallet.';
