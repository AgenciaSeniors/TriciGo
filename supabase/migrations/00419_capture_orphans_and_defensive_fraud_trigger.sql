-- 00419_capture_orphans_and_defensive_fraud_trigger.sql
-- ============================================================================
-- Three drift/defensive findings from the multi-agent audit (2026-06-14), all P3:
--
-- ORPH-1 (defensive): trg_check_fraud_on_transfer (AFTER INSERT ON wallet_transfers,
--   defined in 00013) has NO exception guard. wallet_transfers rows are created
--   atomically inside money RPCs (send_gift = ledger debit/credit + balance UPDATE
--   + wallet_transfers INSERT in one txn). If the fraud check or the fraud_alerts
--   INSERT ever throws, it would roll back the whole transfer — even though fraud
--   bookkeeping is purely best-effort. Its sibling on the same table
--   (send_driver_payout_email) IS defensive, so this is an inconsistency. Fix:
--   wrap the body in BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING; so a
--   fraud-check failure can never roll back the money movement. (Function body
--   otherwise reproduced verbatim from prod.)
--
-- ORPH-2 (drift): rides_sync_coords + rides_sync_coords_trg (BEFORE INSERT/UPDATE
--   ON rides) keep pickup_lat/lng + dropoff_lat/lng in sync with the PostGIS
--   geometry columns. The object was created by hand in prod and exists in NO
--   migration — a DB rebuilt from git would lack it and silently leave those
--   columns NULL (the service layer writes only the geometry and reads the lat/lng
--   columns). Captured verbatim so it is reproducible. No behavior change.
--
-- ORPH-3 (drift): apply_cargo_completion_bonus + trg_apply_cargo_completion_bonus
--   (AFTER UPDATE OF status ON rides) pays the cargo completion bonus. The helper
--   apply_cargo_bonus IS in git (00390/00414) but the trigger wrapper drifted out
--   (only a comment mentions it). Already defensive. Captured verbatim. No
--   behavior change.
--
-- All three reproduced from the live prod definitions; only ORPH-1 adds the
-- EXCEPTION guard.
-- ============================================================================

-- ORPH-1: make the fraud-on-transfer trigger defensive (verbatim body + guard).
CREATE OR REPLACE FUNCTION public.trg_check_fraud_on_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_alert RECORD;
BEGIN
  -- Best-effort fraud bookkeeping must NEVER roll back the underlying transfer
  -- (gift / referral / payout), which is committed atomically with this AFTER
  -- trigger. Guard the whole body. (00419)
  BEGIN
    FOR v_alert IN
      SELECT * FROM check_fraud_signals(NEW.from_user_id)
    LOOP
      -- Only insert if no unresolved alert of same type for this user in last 24h
      IF NOT EXISTS (
        SELECT 1 FROM fraud_alerts
        WHERE user_id = NEW.from_user_id
          AND alert_type = v_alert.alert_type
          AND resolved = false
          AND created_at > NOW() - INTERVAL '24 hours'
      ) THEN
        INSERT INTO fraud_alerts (user_id, alert_type, severity, details)
        VALUES (NEW.from_user_id, v_alert.alert_type, v_alert.severity, v_alert.details);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[trg_check_fraud_on_transfer] fraud check failed for transfer from % : % % — transfer preserved',
      NEW.from_user_id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

-- ORPH-2: capture rides_sync_coords (BEFORE INSERT/UPDATE ON rides) into git, verbatim.
CREATE OR REPLACE FUNCTION public.rides_sync_coords()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.pickup_location IS NOT NULL THEN
    NEW.pickup_lat := ST_Y(NEW.pickup_location::geometry);
    NEW.pickup_lng := ST_X(NEW.pickup_location::geometry);
  END IF;
  IF NEW.dropoff_location IS NOT NULL THEN
    NEW.dropoff_lat := ST_Y(NEW.dropoff_location::geometry);
    NEW.dropoff_lng := ST_X(NEW.dropoff_location::geometry);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS rides_sync_coords_trg ON public.rides;
CREATE TRIGGER rides_sync_coords_trg
  BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.rides_sync_coords();

-- ORPH-3: capture apply_cargo_completion_bonus (AFTER UPDATE OF status ON rides) into git, verbatim.
CREATE OR REPLACE FUNCTION public.apply_cargo_completion_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_dd RECORD; v_driver_user uuid; v_bonus_amount integer; v_result jsonb;
BEGIN
  IF NEW.ride_mode <> 'cargo' OR NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;
  IF NEW.driver_id IS NULL OR NEW.final_fare_cup IS NULL THEN RETURN NEW; END IF;
  SELECT delivery_otp_validated_at, delivery_photo_url INTO v_dd FROM delivery_details WHERE ride_id = NEW.id LIMIT 1;
  IF v_dd.delivery_otp_validated_at IS NULL OR v_dd.delivery_photo_url IS NULL THEN RETURN NEW; END IF;
  SELECT user_id INTO v_driver_user FROM driver_profiles WHERE id = NEW.driver_id LIMIT 1;
  IF v_driver_user IS NULL THEN RETURN NEW; END IF;
  v_bonus_amount := GREATEST(100, ROUND(NEW.final_fare_cup * 0.05)::integer);
  v_result := apply_cargo_bonus(NEW.id, v_driver_user, v_bonus_amount);
  IF (v_result->>'success')::boolean IS NOT TRUE THEN
    RAISE WARNING '[apply_cargo_bonus] failed for ride %: %', NEW.id, v_result;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[apply_cargo_completion_bonus] exception for ride %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_apply_cargo_completion_bonus ON public.rides;
CREATE TRIGGER trg_apply_cargo_completion_bonus
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed'::ride_status AND NEW.ride_mode = 'cargo'::text AND OLD.status IS DISTINCT FROM 'completed'::ride_status)
  EXECUTE FUNCTION public.apply_cargo_completion_bonus();
