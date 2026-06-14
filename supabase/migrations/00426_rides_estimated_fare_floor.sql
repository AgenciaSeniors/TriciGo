-- 00426_rides_estimated_fare_floor.sql
-- ============================================================================
-- FARE-01 (P2, audit 2026-06-14): the strict-parity model charges the rider
-- exactly snapshot.total, which is the CLIENT-supplied rides.estimated_fare_cup
-- (the AFTER-INSERT snapshot trigger does snapshot.total := NEW.estimated_fare_cup,
-- and complete_ride_and_pay charges v_est.total). The DISCOUNT is recomputed
-- server-side and tamper-proof, but the FARE BASE it discounts from is fully
-- trusted from the client. A tampered/buggy client can INSERT a ride with
-- estimated_fare_cup=1 → the snapshot total becomes 1 → strict parity charges
-- 1 CUP → the driver and platform are paid almost nothing.
--
-- Fix: a BEFORE INSERT trigger that floors estimated_fare_cup at the service's
-- minimum fare. The floor uses the CONSERVATIVE (lowest available) min — the
-- service_type_configs.min_fare_cup is materially LOWER than the live
-- pricing_rules min for every service (e.g. triciclo 1440 vs 2200), so a
-- legitimate estimate (which is >= the live rule's min) is NEVER below this floor
-- and is never affected, while the gross tamper (=1) is rejected. Rides with no
-- positive estimate (estimated_fare_cup IS NULL or <= 0, the legacy/no-estimate
-- path) are not this trigger's concern and pass through.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tg_rides_validate_estimated_fare()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_min integer;
BEGIN
  -- Only guard a positive client-supplied estimate (the value strict parity charges).
  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  -- Conservative floor: the lowest configured min for this service. service_type_configs
  -- is lower than pricing_rules for every service today, so a legit estimate is always above it.
  SELECT min_fare_cup INTO v_min
  FROM service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF v_min IS NULL THEN
    SELECT MIN(min_fare_cup) INTO v_min
    FROM pricing_rules
    WHERE service_type = NEW.service_type AND is_active = true;
  END IF;

  -- If we cannot determine a floor, do not block ride creation (fail-open on the
  -- check only — never on ride creation).
  IF v_min IS NOT NULL AND v_min > 0 AND NEW.estimated_fare_cup < v_min THEN
    RAISE EXCEPTION 'estimated_fare_cup % is below the minimum fare % for service % (server-side fare floor / tamper guard)',
      NEW.estimated_fare_cup, v_min, NEW.service_type;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_validate_estimated_fare ON public.rides;
CREATE TRIGGER trg_rides_validate_estimated_fare
  BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_estimated_fare();
