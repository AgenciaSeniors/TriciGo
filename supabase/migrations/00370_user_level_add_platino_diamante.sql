-- 00370: Extend user_level enum to 5 tiers + add tier thresholds (trips-only).
--
-- Part 1 of 2. Postgres forbids USING a freshly ALTER TYPE ... ADD VALUE inside
-- the same transaction it was added. Each Supabase migration is one transaction,
-- so the function/trigger/backfill that reference 'platino'/'diamante' live in the
-- NEXT migration (00371), applied after this one commits.
--
-- Why: the tier system (users.level) was built in 00009 but never wired to the
-- ride flow, so every user is stuck at 'bronce'. We are reviving it as trips-only
-- with 5 levels. See 00371 for the recompute logic.

-- Enum order defines comparison order (bronce < plata < oro < platino < diamante),
-- which the promote-only GREATEST() in 00371 relies on.
ALTER TYPE user_level ADD VALUE IF NOT EXISTS 'platino'  AFTER 'oro';
ALTER TYPE user_level ADD VALUE IF NOT EXISTS 'diamante' AFTER 'platino';

-- Tier thresholds expressed in COMPLETED TRIPS (rider + driver combined per
-- person). Admin-editable without a deploy via platform_config +
-- get_platform_config_numeric (same pattern as shared_ride_discount_per_seat_pct).
-- Stored as jsonb numbers to match the existing numeric-config convention.
INSERT INTO platform_config (key, value) VALUES
  ('tier_plata_min_trips',    '5'::jsonb),
  ('tier_oro_min_trips',      '20'::jsonb),
  ('tier_platino_min_trips',  '50'::jsonb),
  ('tier_diamante_min_trips', '100'::jsonb)
ON CONFLICT (key) DO NOTHING;
