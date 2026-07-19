-- 00504: Bring the get_or_create_referral_code() search_path fix into git.
--        DRIFT FIX — no behaviour change in prod, which already has it.
--
-- WHAT HAPPENED
-- 00319 created get_or_create_referral_code() with
--   SET search_path TO 'public', 'pg_catalog'
-- but the body calls gen_random_bytes(5), which pgcrypto installs into the
-- `extensions` schema. So every call failed with
--   42883: function gen_random_bytes(integer) does not exist
-- and no referral code was ever inserted. The client caught the error, decided
-- it meant "migration not applied", and fell back to an unpersisted placeholder
-- (userId.slice(0,8).toUpperCase()) — which of course no friend could redeem.
-- The feature was dead from 00319 until 2026-07-07.
--
-- WHY THIS MIGRATION EXISTS IF PROD IS ALREADY FIXED
-- The ALTER was applied straight to prod on 2026-07-07 and never committed. As
-- of today prod reports `search_path=public, extensions, pg_catalog`, holds 53
-- real 10-hex codes and 7 redemptions — but **git still describes the broken
-- function**. Rebuild the database from migrations alone and the bug comes
-- straight back, with nothing in the repo to explain it. Same orphan-object
-- class as the security_new_device trigger (see CLAUDE.md).
--
-- WHY `ALTER` AND NOT `CREATE OR REPLACE`
-- The live body was diffed against 00319's: identical (same gen_random_bytes(5),
-- same 28000/P0009 error codes, same 5-attempt retry loop). Only the search_path
-- drifted. Re-declaring the whole body would risk the regression class CLAUDE.md
-- documents under "Cadenas de CREATE OR REPLACE FUNCTION" — a later feature
-- silently reverted by a copy-paste of an older body. Change only what drifted.
--
-- DELIBERATELY NOT INCLUDED: a backfill. An earlier draft (PR #777, written when
-- referral_codes was empty) seeded codes as upper(left(user_id,8)). Running that
-- today would hand guessable 8-hex codes to the 93 users who currently have none,
-- instead of the random 10-hex ones the now-working RPC mints on demand.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'get_or_create_referral_code'
      AND pronamespace = 'public'::regnamespace
  ) THEN
    -- Idempotent: re-running simply re-sets the same value.
    ALTER FUNCTION public.get_or_create_referral_code()
      SET search_path = public, extensions, pg_catalog;
  ELSE
    RAISE WARNING '00504: get_or_create_referral_code() not found; skipping (00319 should have created it)';
  END IF;
END $$;
