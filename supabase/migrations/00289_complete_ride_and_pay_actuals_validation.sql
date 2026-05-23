-- ============================================================
-- DRV-003 (security audit 2026-05-23, Driver fraud kill chain):
-- complete_ride_and_pay accepts p_actual_distance_m and
-- p_actual_duration_s without range validation. The driver app
-- controls these values (they come from the driver's phone GPS),
-- so a malicious driver can call:
--
--   supabase.rpc('complete_ride_and_pay', {
--     p_ride_id, p_driver_id,
--     p_actual_distance_m: 999999,    -- ~1000 km, irrealistic
--     p_actual_duration_s: 7200000    -- 2000 hours
--   });
--
-- and the RPC computes:
--   v_distance_km := 999999 / 1000.0;                    -- 999.999
--   v_raw_fare := base + 999.999 * per_km + ...          -- enormous
--   v_final_fare := GREATEST(v_raw_fare * surge, min_fare);
--
-- The customer's wallet is then debited the inflated amount.
-- BUG-161 (migration 00203) blocks customers/bystanders from calling
-- this RPC — the caller MUST be the assigned driver. So this is a
-- pure driver-fraud vector: legitimately-assigned driver lies about
-- actuals.
--
-- Mitigating context today: GPS tracking via ride_location_events
-- buffers actual route, so reconciliation is possible *after* the
-- fact (compare SUM(ST_Distance) of consecutive points vs
-- actual_distance_m). But there's no real-time enforcement, no
-- alert pipeline, and refunds require manual ops intervention.
--
-- Fix approach: BEFORE UPDATE trigger on rides that validates
-- actual_distance_m and actual_duration_s whenever they change.
-- Fires for both direct UPDATEs (driver bypassing the RPC — the
-- existing enforce_ride_update_columns trigger does NOT block
-- driver-side modification of actuals; only customer-side) and
-- UPDATEs inside complete_ride_and_pay (SECURITY DEFINER, but
-- triggers still fire; auth.uid() persists from the JWT).
--
-- Limits chosen:
--   * Hard floor: distance >= 0, duration >= 0
--   * Absolute ceilings (defense-in-depth for accidental overflow
--     and for the snapshot-less legacy code paths):
--       distance <= 200 km (twice the Habana-Pinar trip + slack)
--       duration <= 8 hours (legal driving day in most jurisdictions)
--   * Relative ceilings against the estimate (catches the realistic
--     inflation vector):
--       distance <= max(2x estimate, 5km)  — 2x is generous, plus
--           the floor of 5km accommodates very short trips where 2x
--           a 200m estimate is still small.
--       duration <= max(3x estimate, 10min) — 3x catches traffic /
--           detours; floor of 10 min accommodates very short trips.
--
-- Admin bypass via is_admin() is preserved so admin tools can mass-
-- update for corrections / dispute resolution without hitting the
-- trigger. Service role / SECDEF system updates also bypass via the
-- auth.uid() IS NULL belt-and-suspenders check (consistent with
-- 00191 pattern).
--
-- Telemetry: RAISE messages include the offending value + estimate
-- so Postgres logs identify the abusive ride. Companion follow-up:
-- background job that compares actual_distance_m vs
-- SUM(ST_Distance(ride_location_events points)) and flags rides
-- where delta > 30% for admin review.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_rides_validate_actuals()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Admin bypass — allow ops corrections / dispute resolution
  -- without the trigger blocking legitimate manual fixes.
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- Service role / cron / system SECDEF callers run as postgres
  -- (or another superuser) without an auth.uid() — let them through.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only validate when actuals actually change.
  IF NEW.actual_distance_m IS NOT DISTINCT FROM OLD.actual_distance_m
     AND NEW.actual_duration_s IS NOT DISTINCT FROM OLD.actual_duration_s THEN
    RETURN NEW;
  END IF;

  -- Distance validation
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
      RAISE EXCEPTION 'actual_distance_m (%) exceeds 2x estimate (% m). Cap: % m. Manual review required.',
        NEW.actual_distance_m,
        OLD.estimated_distance_m,
        GREATEST(OLD.estimated_distance_m * 2, 5000);
    END IF;
  END IF;

  -- Duration validation
  IF NEW.actual_duration_s IS NOT NULL THEN
    IF NEW.actual_duration_s < 0 THEN
      RAISE EXCEPTION 'actual_duration_s cannot be negative (got %)', NEW.actual_duration_s;
    END IF;
    IF NEW.actual_duration_s > 28800 THEN  -- 8 hours
      RAISE EXCEPTION 'actual_duration_s exceeds 8h absolute limit (got % s)', NEW.actual_duration_s;
    END IF;
    IF OLD.estimated_duration_s IS NOT NULL
       AND OLD.estimated_duration_s > 0
       AND NEW.actual_duration_s > GREATEST(OLD.estimated_duration_s * 3, 600) THEN
      RAISE EXCEPTION 'actual_duration_s (%) exceeds 3x estimate (% s). Cap: % s. Manual review required.',
        NEW.actual_duration_s,
        OLD.estimated_duration_s,
        GREATEST(OLD.estimated_duration_s * 3, 600);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rides_validate_actuals ON public.rides;

CREATE TRIGGER trg_rides_validate_actuals
  BEFORE UPDATE ON public.rides
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_rides_validate_actuals();

COMMENT ON TRIGGER trg_rides_validate_actuals ON public.rides IS
  'DRV-003: validates actual_distance_m / actual_duration_s on every UPDATE. Caps: absolute (200km / 8h) + relative (2x distance estimate / 3x duration estimate). Admins bypass via is_admin(). Catches driver-side fare inflation via direct UPDATE or via complete_ride_and_pay inflated parameters.';
