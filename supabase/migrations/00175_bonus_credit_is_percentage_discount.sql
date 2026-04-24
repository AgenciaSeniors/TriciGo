-- ============================================================
-- Operator clarification: `bonus_credit` is a discount type that
-- subtracts a PERCENTAGE of the ride fare (same mechanics as
-- percentage_discount). It's NOT a post-ride wallet credit and
-- it's NOT a fixed-amount discount — the prior code comment in
-- ride.service.ts ("discount is 0, credit applied post-ride") was
-- out of date.
--
-- Three promo types and their discount sources:
--   percentage_discount → reads discount_percent, subtracts % of fare
--   bonus_credit        → reads discount_percent, subtracts % of fare
--                         (semantic sibling — welcome bonus, loyalty
--                         promo, etc. — just a different UI label)
--   fixed_discount      → reads discount_fixed_cup, subtracts flat CUP
--
-- Supersedes the bonus_credit handling from migration 00172
-- (BUG-115 trigger). Also reformats the CASE into an IF/ELSIF ladder
-- because PL/pgSQL CASE expressions require one value per WHEN.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_promo RECORD;
  v_type  TEXT;
  v_correct_discount INTEGER := 0;
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.promo_code_id IS NULL THEN
    IF COALESCE(NEW.discount_amount_cup, 0) <> 0 THEN
      NEW.discount_amount_cup := 0;
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

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

  NEW.discount_amount_cup := GREATEST(v_correct_discount, 0);

  RETURN NEW;
END;
$$;
