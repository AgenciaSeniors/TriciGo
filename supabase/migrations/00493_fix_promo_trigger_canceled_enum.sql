-- Fix: tg_rides_validate_promo_discount compared NEW.status against the literal
-- 'cancelled' (British spelling, 2 L). The ride_status enum uses 'canceled' (1 L,
-- American spelling). Postgres coerces the literal to ride_status at PLAN time
-- (constant folding), the first time the IF expression is planned per connection,
-- BEFORE short-circuit evaluation. So it raises
--   "invalid input value for enum ride_status: cancelled"
-- on EVERY INSERT/UPDATE of rides that fires the trigger — breaking createRide
-- (and accept/cancel/complete) for all users.
--
-- Introduced 2026-07-11 by the promotions_delete_all_references migration
-- (the "-- 00492" block that preserves historical discount on promo delete).
--
-- Patch in-place from the LIVE function body (per CLAUDE.md canonical pattern):
--   * exactly one 'cancelled' literal in the function → precise replace
--   * idempotent (only patches when the literal is present)
--   * cannot lose features (starts from pg_get_functiondef, keeps SECURITY
--     DEFINER + SET search_path + all existing logic)
--   * safe on a fresh git-only DB (undefined_function guard → no-op)
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure)
    INTO v_src;
  IF v_src IS NOT NULL AND position('''cancelled''' IN v_src) > 0 THEN
    EXECUTE replace(v_src, '''cancelled''', '''canceled''');
    RAISE NOTICE 'patched tg_rides_validate_promo_discount: cancelled -> canceled';
  ELSE
    RAISE NOTICE 'no cancelled literal found in tg_rides_validate_promo_discount; nothing to patch';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'tg_rides_validate_promo_discount absent; skipping';
END $patch$;
