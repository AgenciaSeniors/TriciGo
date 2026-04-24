-- ============================================================
-- BUG-115: rides.discount_amount_cup was trusted blindly from the
-- client. The promo flow in packages/api/src/services/ride.service.ts
-- took `promo_code_id` + `discount_amount_cup` straight from the
-- createRide request and INSERTed them into rides without checking:
--   - that the promo is active
--   - that we're inside valid_from/valid_until
--   - that current_uses < max_uses
--   - that discount_amount_cup matches what the promo actually offers
--
-- A malicious client could:
--   * pass a bogus discount with a valid promo_id (FK lets it through)
--   * pass a discount with `promo_code_id = NULL` (no promo at all)
--   * replay an expired/exhausted promo they already knew the UUID of
--   * use a `bonus_credit` promo as if it were a `fixed_discount`
--
-- `complete_ride_and_pay` then blindly subtracts `discount_amount_cup`
-- from the fare, giving away driver earnings + platform commission.
--
-- Fix: BEFORE INSERT/UPDATE trigger that re-computes the correct
-- discount from the promotions table. Silent zero-out is the safe
-- default (ride still goes through, but at full fare). Admins can
-- override ad-hoc discounts via is_admin() bypass (for support
-- compensation or manual comped rides).
--
-- Attack vectors verified neutralized:
--   Vector 1: NULL promo + discount 2000 → discount set to 0
--   Vector 2: valid 20% promo, client claims 2200 (full fare)
--             → recomputed to 440 (correct 20%)
--   Vector 3: expired promo → promo_id dropped, discount 0
--   Vector 4: exhausted promo → promo_id dropped, discount 0
--   Vector 5: bonus_credit promo used as ride discount
--             → discount 0 (promo_id kept for separate bonus flow)
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_promo RECORD;
  v_correct_discount INTEGER := 0;
BEGIN
  -- Admin override: trust whatever admin says (rare, but legitimate
  -- for support compensation or manual testing).
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- No promo referenced → no discount allowed, period.
  IF NEW.promo_code_id IS NULL THEN
    IF COALESCE(NEW.discount_amount_cup, 0) <> 0 THEN
      NEW.discount_amount_cup := 0;
    END IF;
    RETURN NEW;
  END IF;

  -- Look up the promo, re-compute the discount server-side.
  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

  -- Promo doesn't exist, is inactive, expired, not yet valid, or exhausted:
  -- silently zero the discount. The ride still goes through.
  IF v_promo IS NULL
     OR NOT v_promo.is_active
     OR v_promo.valid_from > NOW()
     OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())
     OR (v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses)
  THEN
    NEW.promo_code_id := NULL;
    NEW.discount_amount_cup := 0;
    RETURN NEW;
  END IF;

  -- Recompute the discount from promo data based on type.
  v_correct_discount := CASE v_promo.type::TEXT
    WHEN 'percentage_discount' THEN
      LEAST(
        ROUND(COALESCE(NEW.estimated_fare_cup, 0) * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
        COALESCE(NEW.estimated_fare_cup, 0)
      )
    WHEN 'fixed_discount' THEN
      LEAST(
        COALESCE(v_promo.discount_fixed_cup, 0),
        COALESCE(NEW.estimated_fare_cup, 0)
      )
    ELSE
      -- bonus_credit or unknown types: no ride discount. The bonus
      -- credit is applied separately to the wallet (not via rides).
      0
  END;

  NEW.discount_amount_cup := GREATEST(v_correct_discount, 0);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rides_validate_promo_discount ON public.rides;
CREATE TRIGGER rides_validate_promo_discount
BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup ON public.rides
FOR EACH ROW
EXECUTE FUNCTION public.tg_rides_validate_promo_discount();

COMMENT ON TRIGGER rides_validate_promo_discount ON public.rides IS
  'BUG-115: re-computes discount_amount_cup from the promotions row on every INSERT/UPDATE so the client cannot send an inflated discount. Admin bypass via is_admin().';
