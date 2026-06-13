-- 00408_ride_flow_p2_fixes.sql
-- Ride-flow audit — Fase 2 (P2 robustez). Verified read-only against the LIVE
-- prod function bodies. Plan: ~/.claude/plans/haz-un-analisis-para-dapper-conway.md
--
--   #5  A long trip (actual distance/duration > 2x/3x the estimate) cannot be
--       completed — tg_rides_validate_actuals RAISEs and rolls back completion.
--       Under strict parity the actuals don't affect the fare, so the block is a
--       pure side-effect that strands the driver. Degrade the "exceeds Nx
--       estimate" guards to RAISE WARNING (keep the absolute-sanity caps hard).
--   #7  Cash ride + insurance debits the dead 'driver_cash' wallet instead of
--       'tricicoin' (the 00340 consolidation missed this sub-block).
--   #9a Backgrounded "online" driver is offered rides they can't accept
--       (accept_ride_v2 rejects on a 3-min stale heartbeat, but find_best_drivers
--       only filters is_online). Align dispatch with the accept gate.
--
-- #7 and #9a use a guarded in-place patch (read the LIVE body, string-replace the
-- one target, re-create). This is idempotent and CANNOT drop other features —
-- unlike a 24k-char verbatim CREATE OR REPLACE (cf. the 00124 regression).

-- ============================================================================
-- #5 — tg_rides_validate_actuals: don't block completion on long trips.
-- Absolute-sanity caps (negative, >200km, >8h) stay as hard errors. The
-- "exceeds 2x/3x estimate" checks become WARNINGs so a legitimate long detour
-- can complete (the fare is already snapshot-locked / 1.3x-capped downstream).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.tg_rides_validate_actuals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_distance_m IS NOT DISTINCT FROM OLD.actual_distance_m
     AND NEW.actual_duration_s IS NOT DISTINCT FROM OLD.actual_duration_s THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_distance_m IS NOT NULL THEN
    IF NEW.actual_distance_m < 0 THEN
      RAISE EXCEPTION 'actual_distance_m cannot be negative (got %)', NEW.actual_distance_m;
    END IF;
    IF NEW.actual_distance_m > 200000 THEN
      RAISE EXCEPTION 'actual_distance_m exceeds 200km absolute limit (got % m)', NEW.actual_distance_m;
    END IF;
    IF OLD.estimated_distance_m IS NOT NULL
       AND OLD.estimated_distance_m > 0
       AND NEW.actual_distance_m > GREATEST(OLD.estimated_distance_m * 2, 5000) THEN
      -- 00408: do NOT block completion — strict parity ignores actuals for the
      -- fare, and the legacy path caps chargeable distance at 1.3x. Just flag it.
      RAISE WARNING 'actual_distance_m (%) exceeds 2x estimate (% m) for ride %. Flagged for review; completion allowed.',
        NEW.actual_distance_m, OLD.estimated_distance_m, NEW.id;
    END IF;
  END IF;

  IF NEW.actual_duration_s IS NOT NULL THEN
    IF NEW.actual_duration_s < 0 THEN
      RAISE EXCEPTION 'actual_duration_s cannot be negative (got %)', NEW.actual_duration_s;
    END IF;
    IF NEW.actual_duration_s > 28800 THEN
      RAISE EXCEPTION 'actual_duration_s exceeds 8h absolute limit (got % s)', NEW.actual_duration_s;
    END IF;
    IF OLD.estimated_duration_s IS NOT NULL
       AND OLD.estimated_duration_s > 0
       AND NEW.actual_duration_s > GREATEST(OLD.estimated_duration_s * 3, 600) THEN
      -- 00408: warn instead of blocking (see distance note above).
      RAISE WARNING 'actual_duration_s (%) exceeds 3x estimate (% s) for ride %. Flagged for review; completion allowed.',
        NEW.actual_duration_s, OLD.estimated_duration_s, NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ============================================================================
-- #7 — complete_ride_and_pay: cash-ride insurance premium must come from the
-- driver's live 'tricicoin' wallet, not the dead 'driver_cash'. In-place patch
-- of the single occurrence (verified: exactly 1 in prod).
-- ============================================================================
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.complete_ride_and_pay(uuid,uuid,integer,integer)'::regprocedure)
    INTO v_src;
  IF v_src IS NOT NULL
     AND position('ensure_wallet_account(v_driver_user_id, ''driver_cash'')' IN v_src) > 0 THEN
    EXECUTE replace(
      v_src,
      'ensure_wallet_account(v_driver_user_id, ''driver_cash'')',
      'ensure_wallet_account(v_driver_user_id, ''tricicoin'')'
    );
    RAISE NOTICE '00408: complete_ride_and_pay cash-insurance wallet patched driver_cash -> tricicoin';
  ELSE
    RAISE NOTICE '00408: complete_ride_and_pay already tricicoin (no-op)';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00408: complete_ride_and_pay absent; skipping cash-insurance patch';
END $patch$;

-- ============================================================================
-- #9a — find_best_drivers: exclude drivers with a stale heartbeat, aligned with
-- accept_ride_v2's gate (NULL heartbeat allowed; >3 min stale rejected). Without
-- this, a backgrounded "online" driver is offered rides accept_ride_v2 rejects.
-- In-place patch of the single 'WHERE dp.is_online = true' anchor.
-- ============================================================================
DO $patch$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(
    'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure)
    INTO v_src;
  IF v_src IS NOT NULL
     AND position('WHERE dp.is_online = true' IN v_src) > 0
     AND position('last_heartbeat_at' IN v_src) = 0 THEN
    EXECUTE replace(
      v_src,
      'WHERE dp.is_online = true',
      'WHERE dp.is_online = true' || E'\n      AND (dp.last_heartbeat_at IS NULL OR dp.last_heartbeat_at > now() - interval ''3 minutes'')'
    );
    RAISE NOTICE '00408: find_best_drivers patched with heartbeat-freshness filter';
  ELSE
    RAISE NOTICE '00408: find_best_drivers heartbeat filter already present or anchor missing (no-op)';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00408: find_best_drivers absent; skipping heartbeat patch';
END $patch$;
