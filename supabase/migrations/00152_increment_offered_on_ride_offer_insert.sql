-- ============================================================
-- BUG-087 fix: driver_profiles.total_rides_offered was never
-- incremented. The dispatch_ride() function inserts into
-- ride_offers but does not touch the counter, causing
-- acceptance_rate to be derived from a stale denominator (often 0,
-- making the ratio display "10000%" in the driver profile UI once
-- a single accept happens).
--
-- Strategy: simple AFTER INSERT trigger on ride_offers that bumps
-- the counter. Idempotent via ON CONFLICT DO NOTHING in
-- dispatch_ride still protects against double-counts because the
-- trigger fires only on successful row insertion.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_ride_offer_increment_offered()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  UPDATE driver_profiles
     SET total_rides_offered = COALESCE(total_rides_offered, 0) + 1
   WHERE id = NEW.driver_profile_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ride_offers_increment_offered ON public.ride_offers;
CREATE TRIGGER ride_offers_increment_offered
AFTER INSERT ON public.ride_offers
FOR EACH ROW
EXECUTE FUNCTION public.tg_ride_offer_increment_offered();

COMMENT ON TRIGGER ride_offers_increment_offered ON public.ride_offers IS
  'Increments driver_profiles.total_rides_offered when dispatch creates a new offer. Pairs with acceptance_rate denominator.';

-- One-time reconciliation from actual ride_offers data
UPDATE driver_profiles dp
   SET total_rides_offered = sub.cnt
  FROM (
    SELECT driver_profile_id, COUNT(*) AS cnt
    FROM ride_offers
    GROUP BY driver_profile_id
  ) sub
 WHERE dp.id = sub.driver_profile_id
   AND COALESCE(dp.total_rides_offered, 0) < sub.cnt;
