-- ============================================================
-- BUG-163: TypeScript types in packages/types/src/* declare a
-- handful of columns as non-nullable that the DB schema actually
-- allows NULL on. The most impactful is rides.payment_status —
-- 68 / 85 production rows were NULL because canceled rides never
-- had a payment intent, while the TS Ride interface promises
-- `payment_status: PaymentStatus` (no null). Any code path that
-- compares `ride.payment_status === 'pending'` would silently miss
-- those 80% NULL rows even though TS claimed it couldn't be null.
--
-- Fix: backfill, set DEFAULT, tighten CHECK, then SET NOT NULL.
-- This makes the DB schema match the TypeScript contract that the
-- entire app already assumed was true.
--
-- Columns tightened:
--   rides.payment_status        — backfill NULL→'not_applicable'
--   rides.tip_amount            — default 0 already, just SET NOT NULL
--   rides.surge_multiplier      — default 1.0 already
--   rides.cancellation_fee_cup  — default 0 already
--   rides.cancellation_fee_trc  — default 0 already
--   rides.passenger_count       — default 1 already
--   wallet_accounts.is_frozen   — default false already
--
-- Note: rides.is_split, rides.scheduled_notified, etc. are left
-- nullable on purpose because the TS types declare them optional
-- (?:) — those are aligned. Only fixing actual non-null/null drift.
-- ============================================================

-- ── rides.payment_status (the critical one) ──────────────────
-- 1. Backfill the 68 NULL rows. They're all canceled cash rides,
--    so 'not_applicable' is the right semantic — the ride was
--    never paid because it was canceled before payment.
UPDATE public.rides
SET payment_status = 'not_applicable'
WHERE payment_status IS NULL;

-- 2. Set a default so future inserts get a value.
ALTER TABLE public.rides
  ALTER COLUMN payment_status SET DEFAULT 'not_applicable';

-- 3. Tighten the CHECK constraint to drop the IS NULL escape hatch.
ALTER TABLE public.rides DROP CONSTRAINT IF EXISTS chk_payment_status_valid;
ALTER TABLE public.rides
  ADD CONSTRAINT chk_payment_status_valid
  CHECK (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'captured'::text,
    'completed'::text, 'failed'::text, 'refunded'::text, 'partially_refunded'::text,
    'not_applicable'::text]));

-- 4. SET NOT NULL.
ALTER TABLE public.rides
  ALTER COLUMN payment_status SET NOT NULL;

-- ── rides — defense-in-depth NOT NULL on columns that
--    already have safe defaults but tolerated NULL. Production
--    data confirmed 0 NULLs in these columns.
ALTER TABLE public.rides
  ALTER COLUMN tip_amount SET NOT NULL;
ALTER TABLE public.rides
  ALTER COLUMN surge_multiplier SET NOT NULL;
ALTER TABLE public.rides
  ALTER COLUMN cancellation_fee_cup SET NOT NULL;
ALTER TABLE public.rides
  ALTER COLUMN cancellation_fee_trc SET NOT NULL;
ALTER TABLE public.rides
  ALTER COLUMN passenger_count SET NOT NULL;

-- ── wallet_accounts.is_frozen ────────────────────────────────
-- TS WalletAccount declares is_frozen: boolean (non-null).
-- Default is already `false`, no NULLs in production. SET NOT NULL.
ALTER TABLE public.wallet_accounts
  ALTER COLUMN is_frozen SET NOT NULL;
