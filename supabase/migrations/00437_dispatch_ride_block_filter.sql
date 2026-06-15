-- 00437 — Enforce mutual blocks in the matching engine
--
-- dispatch_ride inserts ride_offers from find_best_drivers(...). find_best_drivers
-- already RETURNS user_id, and dispatch_ride already holds v_ride.customer_id, so
-- we filter the blocked pair right in the INSERT...SELECT — no need to change
-- find_best_drivers' signature (no arity change, no lost grants).
--
-- Mutual: excludes the offer whether the customer blocked the driver OR the
-- driver blocked the customer. Depends on user_blocks (00436).
--
-- In-place patch over the LIVE body (pg_get_functiondef → replace → EXECUTE) so
-- we don't risk dropping features if dispatch_ride was changed by a parallel
-- migration. Idempotent (guarded on the 'user_blocks' marker) and safe on a DB
-- where dispatch_ride doesn't exist yet.

DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_ride(uuid,integer)'::regprocedure) INTO v_src;

  IF v_src IS NULL OR position('user_blocks' IN v_src) > 0 THEN
    RAISE NOTICE '00437: dispatch_ride already patched or not found; skipping';
    RETURN;
  END IF;

  -- Insert the WHERE NOT EXISTS just before the existing ON CONFLICT clause.
  v_src := replace(
    v_src,
    'ON CONFLICT (ride_id, driver_profile_id) DO NOTHING',
    E'WHERE NOT EXISTS (\n    SELECT 1 FROM public.user_blocks ub\n    WHERE (ub.blocker_id = v_ride.customer_id AND ub.blocked_id = fbd.user_id)\n       OR (ub.blocker_id = fbd.user_id AND ub.blocked_id = v_ride.customer_id)\n  )\n  ON CONFLICT (ride_id, driver_profile_id) DO NOTHING'
  );

  EXECUTE v_src;
  RAISE NOTICE '00437: dispatch_ride patched with user_blocks mutual filter';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00437: dispatch_ride absent; skipping';
END
$patch$;
