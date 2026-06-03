-- 00371: Wire the user tier system (trips-only) end to end.
--
-- Part 2 of 2 (00370 added 'platino'/'diamante' + the threshold config rows).
--
-- Root cause this fixes (verified against prod, not just migrations):
--   users.level never moved off 'bronce' because
--     (a) nothing ever counted a user's completed trips
--         (complete_ride_and_pay only bumps driver_profiles.total_rides_completed,
--          never the per-user counters), and
--     (b) the promotion fn maybe_promote_user_level() had ZERO callers
--         (the trigger 00015 claimed to create is NOT present in prod's rides).
--
-- New design: recompute the level from the SOURCE OF TRUTH (the rides table) on
-- every completion, for BOTH the customer and the driver. We SET the counter from
-- the real count (never +1), so it is self-healing and cannot drift like the
-- legacy total_rides counter did (see CLAUDE.md "stale precomputed field").

-- 1) Recompute a person's tier from their actual completed trips (rider+driver).
CREATE OR REPLACE FUNCTION recompute_user_level(p_user_id uuid)
RETURNS user_level
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trips int;
  v_new   user_level;
  v_final user_level;
BEGIN
  SELECT
      (SELECT count(*) FROM rides r
        WHERE r.customer_id = p_user_id AND r.status = 'completed')
    + (SELECT count(*) FROM rides r
        JOIN driver_profiles dp ON dp.id = r.driver_id
        WHERE dp.user_id = p_user_id AND r.status = 'completed')
  INTO v_trips;

  v_new := (CASE
    WHEN v_trips >= get_platform_config_numeric('tier_diamante_min_trips', 100) THEN 'diamante'
    WHEN v_trips >= get_platform_config_numeric('tier_platino_min_trips',   50) THEN 'platino'
    WHEN v_trips >= get_platform_config_numeric('tier_oro_min_trips',       20) THEN 'oro'
    WHEN v_trips >= get_platform_config_numeric('tier_plata_min_trips',      5) THEN 'plata'
    ELSE 'bronce'
  END)::user_level;

  -- Refresh the display cache (derived SET, never +1 -> no drift) and promote
  -- only (GREATEST) so earned tiers / manual admin overrides are never lowered.
  UPDATE users
     SET total_rides = v_trips,
         level       = GREATEST(level, v_new)
   WHERE id = p_user_id
  RETURNING level INTO v_final;

  RETURN v_final;
END;
$$;

-- 2) Recompute on ride completion for the customer AND the driver.
--    Defensive: a tier recompute failure must NEVER block ride completion
--    (same EXCEPTION-swallow pattern as the estimate-snapshot trigger).
CREATE OR REPLACE FUNCTION tg_recompute_level_on_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_driver_user uuid;
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    PERFORM recompute_user_level(NEW.customer_id);
  END IF;
  IF NEW.driver_id IS NOT NULL THEN
    SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = NEW.driver_id;
    IF v_driver_user IS NOT NULL THEN
      PERFORM recompute_user_level(v_driver_user);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'recompute_user_level failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_level_on_complete ON rides;
CREATE TRIGGER trg_recompute_level_on_complete
  AFTER UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status <> 'completed')
  EXECUTE FUNCTION tg_recompute_level_on_complete();

-- 3) Deprecate the orphan promote fn (do not drop yet; repo convention is to
--    DROP only after a window confirms zero callers).
COMMENT ON FUNCTION maybe_promote_user_level(uuid)
  IS '00371 DEPRECATED: replaced by recompute_user_level (trips-only, both roles). No callers.';

-- 4) One-time backfill: recompute everyone from history. Idempotent (deterministic
--    from the rides table), safe to re-run.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM users LOOP
    PERFORM recompute_user_level(r.id);
  END LOOP;
END $$;
