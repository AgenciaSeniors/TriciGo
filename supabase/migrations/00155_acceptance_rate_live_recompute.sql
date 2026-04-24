-- ============================================================
-- Keep driver_profiles.acceptance_rate in sync with the live
-- ride_offers data. Complements 00152 (which only increments
-- total_rides_offered on INSERT).
--
-- Triggered on ride_offers UPDATE when status transitions from
-- 'pending' to a terminal state ('accepted'|'rejected'|'expired'|
-- 'superseded'). We recompute acceptance_rate as
--   LEAST(100, ROUND(100 * accepted / total_offers, 1))
-- When total_offers is 0 we default to 100 so new drivers are not
-- penalized in find_best_drivers' ranking.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_ride_offer_refresh_acceptance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_total    integer;
  v_accepted integer;
BEGIN
  -- Only act on terminal-state transitions
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_total
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id;

  SELECT COUNT(*) INTO v_accepted
  FROM ride_offers
  WHERE driver_profile_id = NEW.driver_profile_id
    AND status = 'accepted';

  UPDATE driver_profiles
     SET acceptance_rate = CASE
       WHEN v_total = 0 THEN 100.0
       ELSE LEAST(100.0, ROUND(100.0 * v_accepted::numeric / v_total, 1))
     END
   WHERE id = NEW.driver_profile_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ride_offers_refresh_acceptance ON public.ride_offers;
CREATE TRIGGER ride_offers_refresh_acceptance
AFTER UPDATE OF status ON public.ride_offers
FOR EACH ROW
EXECUTE FUNCTION public.tg_ride_offer_refresh_acceptance();

COMMENT ON TRIGGER ride_offers_refresh_acceptance ON public.ride_offers IS
  'Keeps driver_profiles.acceptance_rate in sync with ride_offers outcomes.';
