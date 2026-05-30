-- ============================================================
-- Migration 00347: "Compartir viaje" (shared ride)
--
-- For tricycle rides, the rider can opt in to "Compartir viaje": the
-- driver may fill the empty seats with other (off-platform, cash-paid)
-- passengers, and the rider gets a discount of X% per free seat.
--   - Only `triciclo_basico` (the single passenger tricycle).
--   - Capacity from service_type_configs.max_passengers (corrected to 4).
--   - Free seats = capacity − seats the rider declares they occupy.
--   - Discount is UPFRONT (for offering), stacks with promo, no cap
--     (bounded only by the fare itself).
--   - The discount is computed SERVER-SIDE (anti-tamper) by extending
--     the existing promo-validation trigger (BUG-115 / 00172, hardened
--     in 00320/00322). The client cannot inflate it.
--   - complete_ride_and_pay and the estimate snapshot are NOT touched:
--     they already do `final = snapshot.total − discount_amount_cup`.
--   - Extra passengers pay the driver in cash, off-platform; the app
--     does not track them. The driver is paid on the discounted fare.
-- ============================================================

-- 1) Correct the tricycle capacity (was 8; the real passenger tricycle holds 4).
UPDATE service_type_configs SET max_passengers = 4 WHERE slug = 'triciclo_basico';

-- 2) Admin-configurable discount per free seat (default 7%).
INSERT INTO platform_config (key, value)
VALUES ('shared_ride_discount_per_seat_pct', '7')
ON CONFLICT (key) DO NOTHING;

-- 3) Ride columns.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS shared_ride BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS shared_ride_seats_occupied INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS shared_ride_discount_cup INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN rides.shared_ride IS '00347: rider opted in to "Compartir viaje" (driver may fill empty seats).';
COMMENT ON COLUMN rides.shared_ride_seats_occupied IS '00347: seats the rider declares they occupy (incl. themselves). Free = max_passengers − this.';
COMMENT ON COLUMN rides.shared_ride_discount_cup IS '00347: portion of discount_amount_cup attributable to sharing (audit/display). Computed server-side.';

-- 4) Extend the promo-validation trigger to also compute the shared-ride
--    discount server-side and SUM it into discount_amount_cup. This is the
--    LIVE version (00320/00322: atomic promo claim + super_admin audit) with
--    the shared-ride block added + every discount assignment carrying the
--    shared part so it applies even on rides without a promo.
CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_promo RECORD;
  v_type TEXT;
  v_correct_discount INTEGER := 0;
  v_slot_claimed BOOLEAN := false;
  v_supplied_discount INTEGER := COALESCE(NEW.discount_amount_cup, 0);
  -- Shared ride ("Compartir viaje") — computed server-side, anti-tamper.
  v_shared_discount INTEGER := 0;
  v_cap INTEGER;
  v_occ INTEGER;
  v_free INTEGER;
  v_pct NUMERIC;
BEGIN
  -- Compute the shared-ride discount up front so it applies on every path
  -- (including rides with no promo). Only honored for triciclo_basico.
  IF COALESCE(NEW.shared_ride, false) AND NEW.service_type = 'triciclo_basico' THEN
    v_cap := COALESCE((SELECT max_passengers FROM service_type_configs WHERE slug = NEW.service_type), 4);
    v_occ := LEAST(GREATEST(COALESCE(NEW.shared_ride_seats_occupied, 1), 1), v_cap - 1);
    v_free := GREATEST(v_cap - v_occ, 0);
    v_pct := get_platform_config_numeric('shared_ride_discount_per_seat_pct', 7);
    NEW.shared_ride_seats_occupied := v_occ;
    v_shared_discount := LEAST(
      FLOOR(COALESCE(NEW.estimated_fare_cup, 0) * v_free * v_pct / 100.0)::INTEGER,
      COALESCE(NEW.estimated_fare_cup, 0)
    );
    NEW.shared_ride_discount_cup := v_shared_discount;
  ELSE
    NEW.shared_ride := false;
    NEW.shared_ride_seats_occupied := NULL;
    NEW.shared_ride_discount_cup := 0;
  END IF;

  -- super_admin bypass (manual comped rides) — trust the supplied discount,
  -- audit it. (Shared-ride discount is not auto-applied on this path.)
  IF is_super_admin() THEN
    IF v_supplied_discount <> 0 OR NEW.promo_code_id IS NOT NULL THEN
      INSERT INTO admin_promo_audit_log (
        admin_user_id, ride_id, customer_id,
        promo_code_id, discount_amount_cup_supplied,
        estimated_fare_cup, notes
      ) VALUES (
        auth.uid(), NEW.id, NEW.customer_id,
        NEW.promo_code_id, v_supplied_discount,
        NEW.estimated_fare_cup,
        format('TG_OP=%s super_admin bypass', TG_OP)
      );
    END IF;
    RETURN NEW;
  END IF;

  -- No promo → discount is just the shared-ride part (0 if not shared).
  IF NEW.promo_code_id IS NULL THEN
    NEW.discount_amount_cup := v_shared_discount;
    RETURN NEW;
  END IF;

  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

  IF v_promo IS NULL
     OR NOT v_promo.is_active
     OR v_promo.valid_from > NOW()
     OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())
  THEN
    NEW.promo_code_id := NULL;
    NEW.discount_amount_cup := v_shared_discount;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)
      VALUES (v_promo.id, NEW.customer_id, NEW.id);
    EXCEPTION WHEN unique_violation THEN
      NEW.promo_code_id := NULL;
      NEW.discount_amount_cup := v_shared_discount;
      RETURN NEW;
    END;

    UPDATE promotions
    SET current_uses = current_uses + 1
    WHERE id = v_promo.id
      AND (max_uses IS NULL OR current_uses < max_uses)
    RETURNING true INTO v_slot_claimed;

    IF NOT COALESCE(v_slot_claimed, false) THEN
      DELETE FROM promotion_uses
      WHERE promotion_id = v_promo.id
        AND user_id = NEW.customer_id
        AND ride_id = NEW.id;
      NEW.promo_code_id := NULL;
      NEW.discount_amount_cup := v_shared_discount;
      RETURN NEW;
    END IF;
  END IF;

  v_type := v_promo.type::TEXT;

  IF v_type IN ('percentage_discount', 'bonus_credit') THEN
    v_correct_discount := LEAST(
      ROUND(COALESCE(NEW.estimated_fare_cup, 0) * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      COALESCE(NEW.estimated_fare_cup, 0)
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_correct_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      COALESCE(NEW.estimated_fare_cup, 0)
    );
  ELSE
    v_correct_discount := 0;
  END IF;

  -- Promo + shared, summed, capped at the fare (never negative downstream).
  NEW.discount_amount_cup := LEAST(
    GREATEST(v_correct_discount, 0) + v_shared_discount,
    COALESCE(NEW.estimated_fare_cup, 0)
  );
  RETURN NEW;
END;
$function$;

-- Recreate the trigger so it also fires when the shared-ride columns change.
DROP TRIGGER IF EXISTS rides_validate_promo_discount ON public.rides;
CREATE TRIGGER rides_validate_promo_discount
BEFORE INSERT OR UPDATE OF promo_code_id, discount_amount_cup, shared_ride, shared_ride_seats_occupied ON public.rides
FOR EACH ROW
EXECUTE FUNCTION public.tg_rides_validate_promo_discount();

COMMENT ON TRIGGER rides_validate_promo_discount ON public.rides IS
  '00347: re-computes discount_amount_cup server-side = promo discount + shared-ride discount (Compartir viaje). Anti-tamper, extends BUG-115/00172 (atomic promo claim from 00320/00322).';
