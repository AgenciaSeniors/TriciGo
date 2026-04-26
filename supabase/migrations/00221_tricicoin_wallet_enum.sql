-- ============================================================
-- BUG-210 (5): add `tricicoin` to wallet_account_type enum.
--
-- Background: the enum already has `driver_quota` (added in some
-- past migration) but no rows of that type exist anywhere in the
-- system. The user reports that platform commission should be
-- deducted from the driver's TriciCoin balance — a separate wallet
-- denominated 1:1 with CUP. We add `tricicoin` as a fresh,
-- semantically clear name and leave `driver_quota` in place
-- (Postgres can't drop enum values without rebuilding the type).
--
-- This migration ONLY adds the enum value. Seeding wallets and
-- updating the RPCs that use it must happen in subsequent
-- migrations — Postgres requires the ALTER TYPE to commit before
-- the new value can be referenced (e.g. by INSERT ... 'tricicoin'
-- or `WHERE account_type = 'tricicoin'`).
-- ============================================================

ALTER TYPE wallet_account_type ADD VALUE IF NOT EXISTS 'tricicoin';

COMMENT ON TYPE wallet_account_type IS
  'Wallet account types. `tricicoin` (added 2026-04-25) is the '
  'driver-side credit balance from which platform commission is '
  'deducted at ride completion. Denominated 1:1 with CUP. Drivers '
  'top it up via cash recharge or earn it via referrals/promos. '
  '`driver_quota` is a legacy unused alias — do not write new code '
  'against it.';
