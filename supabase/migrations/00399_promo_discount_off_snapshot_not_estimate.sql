-- ============================================================================
-- 00399 — Fare-manipulation P0: compute discount off the FROZEN fare, not the
--          mutable estimated_fare_cup (F2-FARE, audit pass #2 2026-06-10)
-- ============================================================================
-- PROVEN free-ride exploit (rolled-back DO-block in prod):
--   1. Customer creates a normal triciclo ride: estimated_fare_cup=2200, and
--      tg_rides_create_estimate_snapshot freezes snapshot.total=2200.
--   2. Customer (any authenticated user, via a direct PostgREST PATCH on their
--      own ride — the CLI-001 threat model) sends:
--        UPDATE rides SET estimated_fare_cup=999999, shared_ride=true,
--                         shared_ride_seats_occupied=1 WHERE id=<their ride>;
--      enforce_ride_update_columns does NOT block estimated_fare_cup /
--      shared_ride for the customer branch, so the PATCH passes.
--   3. tg_rides_validate_promo_discount fires (UPDATE OF shared_ride) and
--      computed the shared-ride discount off NEW.estimated_fare_cup:
--        discount = FLOOR(999999 * 3 * 7/100) = 209999.
--   4. complete_ride_and_pay (strict parity) charges
--        final = GREATEST(snapshot.total - discount, 0) = GREATEST(2200-209999,0) = 0.
--      → the rider completes a real trip and pays 0.
--
-- ROOT CAUSE: the discount is a % of the fare, but it was computed off the
-- MUTABLE estimated_fare_cup while the CHARGE uses the IMMUTABLE estimate
-- snapshot (ride_pricing_snapshots, which customers cannot UPDATE — no write
-- policy). The shared-ride feature (00347) introduced the estimated_fare_cup
-- dependency; CLI-001 (00290) had left estimated_fare_cup customer-writable
-- because the snapshot was the source of truth for the charge.
--
-- FIX (surgical, root-cause): the discount base is now
--   v_fare_base := COALESCE(
--      <estimate snapshot total>,                       -- immutable contract
--      CASE WHEN UPDATE THEN OLD.estimated_fare_cup     -- pre-PATCH value
--           ELSE NEW.estimated_fare_cup END,            -- INSERT: the contract
--      0)
-- so inflating estimated_fare_cup in the same statement can never inflate the
-- discount. On INSERT (snapshot not created yet — it's an AFTER INSERT trigger)
-- the base is NEW.estimated_fare_cup, which is exactly the fare being quoted.
-- Legit shared/promo discounts are unchanged (computed off the real fare).
--
-- Body reproduced VERBATIM from prod pg_get_functiondef (2026-06-10); the ONLY
-- change is introducing v_fare_base and using it in the 4 discount math sites.
-- enforce_ride_update_columns / cancel / waypoint-recalc flows are NOT touched
-- (estimated_fare_cup stays writable for the add-stop recalc).
-- NOT applied to prod yet (MCP guard).
-- ============================================================================

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
  v_shared_discount INTEGER := 0;
  v_cap INTEGER;
  v_occ INTEGER;
  v_free INTEGER;
  v_pct NUMERIC;
  v_fare_base INTEGER;   -- 00399: immutable fare base for ALL discount math
BEGIN
  -- 00399 (F2-FARE): never trust the mutable NEW.estimated_fare_cup as the
  -- discount base. Prefer the frozen estimate snapshot (customers cannot
  -- UPDATE it); on UPDATE without a snapshot fall back to OLD.estimated_fare_cup
  -- (the value BEFORE this statement) so it can't be inflated in-place; on
  -- INSERT use NEW.estimated_fare_cup (that IS the fare being quoted).
  v_fare_base := COALESCE(
    (SELECT total FROM ride_pricing_snapshots
       WHERE ride_id = NEW.id AND snapshot_type = 'estimate' LIMIT 1),
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.estimated_fare_cup ELSE NEW.estimated_fare_cup END,
    0
  );

  IF COALESCE(NEW.shared_ride, false) AND NEW.service_type = 'triciclo_basico' THEN
    v_cap := COALESCE((SELECT max_passengers FROM service_type_configs WHERE slug = NEW.service_type), 4);
    v_occ := LEAST(GREATEST(COALESCE(NEW.shared_ride_seats_occupied, 1), 1), v_cap - 1);
    v_free := GREATEST(v_cap - v_occ, 0);
    v_pct := get_platform_config_numeric('shared_ride_discount_per_seat_pct', 7);
    NEW.shared_ride_seats_occupied := v_occ;
    v_shared_discount := LEAST(
      FLOOR(v_fare_base * v_free * v_pct / 100.0)::INTEGER,
      v_fare_base
    );
    NEW.shared_ride_discount_cup := v_shared_discount;
  ELSE
    NEW.shared_ride := false;
    NEW.shared_ride_seats_occupied := NULL;
    NEW.shared_ride_discount_cup := 0;
  END IF;

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
      ROUND(v_fare_base * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      v_fare_base
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_correct_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      v_fare_base
    );
  ELSE
    v_correct_discount := 0;
  END IF;

  NEW.discount_amount_cup := LEAST(
    GREATEST(v_correct_discount, 0) + v_shared_discount,
    v_fare_base
  );
  RETURN NEW;
END;
$function$;
