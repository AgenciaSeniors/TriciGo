-- ============================================================
-- P-CRIT-1 + P-CRIT-2 + P-HIGH-4: promo atomic claim + cancel
-- rollback + per-user dedupe.
--
-- Bugs cerrados:
--
-- P-CRIT-1: `tg_rides_validate_promo_discount` (00175) lee
--   `current_uses` sin row lock antes de aplicar el descuento.
--   `increment_promo_uses` se llama DESPUÉS del INSERT del ride
--   desde ride.service.ts. Dos clientes simultáneos sobre el
--   último slot → ambos pasan la validación → ambos terminan
--   con discount → N+1 redenciones para un promo con max_uses=N.
--
-- P-CRIT-2: el counter `current_uses` se incrementa al crear el
--   ride, pero NUNCA se decrementa al cancelar. Un promo con
--   max_uses=100 y 50 cancelaciones queda bloqueado prematuramente
--   (current_uses=100, redenciones reales=50). Además el user
--   queda con un row en promotion_uses → no puede re-usar el promo
--   ni siquiera si todos sus rides anteriores fueron cancelados.
--
-- P-HIGH-4: el trigger valida promo state pero NO chequea
--   `promotion_uses(promotion_id, user_id)` antes de aplicar el
--   discount. La UNIQUE constraint solo aplica al INSERT post-
--   ride. Race exploit: user solicita 2 rides en paralelo con
--   el mismo promo_code_id → ambos calculan discount → uno gana
--   el insert promotion_uses, el otro cae en el catch block del
--   service y borra el record → doble redención single-user.
--
-- Fix:
--
-- 1) `promotion_uses_ride_id_fkey` → DEFERRABLE INITIALLY DEFERRED.
--    Permite que el BEFORE INSERT trigger de rides inserte un row
--    en promotion_uses referenciando NEW.id (rides aún no committed).
--    FK se valida al commit de la transacción cuando rides ya existe.
--
-- 2) `tg_rides_validate_promo_discount` se extiende:
--    - INSERT atómico en promotion_uses (UNIQUE catch el dedupe per-user
--      y la race entre rides simultáneos del mismo user).
--    - UPDATE atómico `SET current_uses=current_uses+1 WHERE current_uses<max_uses
--      RETURNING true`. Si retorna 0 rows, el slot está exhausto →
--      DELETE promotion_uses (rollback) + zero discount.
--
-- 3) Nuevo trigger `tg_rides_rollback_promo_on_cancel` AFTER UPDATE:
--    cuando ride.status pasa a 'canceled', decrementa current_uses
--    y borra promotion_uses para liberar el slot.
--
-- 4) `increment_promo_uses` queda como no-op (alias para compat
--    backward con clientes pre-migración). El service-layer sigue
--    llamándolo sin efecto.
-- ============================================================

-- 1) Hacer el FK promotion_uses.ride_id deferrable.
--    Necesario porque el BEFORE INSERT trigger inserta en
--    promotion_uses con ride_id = NEW.id antes de que la fila
--    de rides exista físicamente.
ALTER TABLE promotion_uses
  DROP CONSTRAINT IF EXISTS promotion_uses_ride_id_fkey;

ALTER TABLE promotion_uses
  ADD CONSTRAINT promotion_uses_ride_id_fkey
  FOREIGN KEY (ride_id) REFERENCES rides(id) DEFERRABLE INITIALLY DEFERRED;

-- 2) Reemplazar tg_rides_validate_promo_discount con versión que:
--    a) hace dedupe per-user via INSERT promotion_uses (UNIQUE catch)
--    b) hace claim atómico del slot via UPDATE...WHERE...RETURNING
--    c) rollback de (a) si (b) falla
CREATE OR REPLACE FUNCTION public.tg_rides_validate_promo_discount()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_promo RECORD;
  v_type TEXT;
  v_correct_discount INTEGER := 0;
  v_slot_claimed BOOLEAN := false;
BEGIN
  -- Admin bypass: trust whatever admin says (rare, but legitimate
  -- for support compensation or manual testing). Sin audit log
  -- hasta PR D (P-HIGH-5).
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- No promo referenced → no discount allowed.
  IF NEW.promo_code_id IS NULL THEN
    IF COALESCE(NEW.discount_amount_cup, 0) <> 0 THEN
      NEW.discount_amount_cup := 0;
    END IF;
    RETURN NEW;
  END IF;

  -- Look up the promo. Validate state (active, in window).
  SELECT * INTO v_promo FROM promotions WHERE id = NEW.promo_code_id;

  IF v_promo IS NULL
     OR NOT v_promo.is_active
     OR v_promo.valid_from > NOW()
     OR (v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW())
  THEN
    NEW.promo_code_id := NULL;
    NEW.discount_amount_cup := 0;
    RETURN NEW;
  END IF;

  -- P-HIGH-4 + P-CRIT-1: solo en INSERT hacemos dedupe + slot claim.
  -- UPDATE de promo_code_id en un ride existente es admin-only territory
  -- (cliente no puede mutar promo_code_id post-creation por enforce_ride_update_columns).
  IF TG_OP = 'INSERT' THEN
    -- Dedupe + reserva atómica via INSERT en promotion_uses.
    -- La UNIQUE(promotion_id, user_id) bloquea race entre dos
    -- rides simultáneos del mismo user (escenario P-HIGH-4).
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)
      VALUES (v_promo.id, NEW.customer_id, NEW.id);
    EXCEPTION WHEN unique_violation THEN
      -- User ya usó este promo → zero discount (safe default).
      NEW.promo_code_id := NULL;
      NEW.discount_amount_cup := 0;
      RETURN NEW;
    END;

    -- P-CRIT-1: claim atómico del slot via UPDATE conditional + RETURNING.
    -- Si el último slot fue tomado por otra transacción, la condición
    -- current_uses < max_uses falla → UPDATE no afecta filas →
    -- RETURNING devuelve NULL → claimed=false.
    UPDATE promotions
    SET current_uses = current_uses + 1
    WHERE id = v_promo.id
      AND (max_uses IS NULL OR current_uses < max_uses)
    RETURNING true INTO v_slot_claimed;

    IF NOT COALESCE(v_slot_claimed, false) THEN
      -- Slot exhausto post-validación. Rollback el promotion_use
      -- que acabamos de insertar (queremos que el user lo pueda
      -- reusar en un ride futuro si más slots se liberan).
      DELETE FROM promotion_uses
      WHERE promotion_id = v_promo.id
        AND user_id = NEW.customer_id
        AND ride_id = NEW.id;
      NEW.promo_code_id := NULL;
      NEW.discount_amount_cup := 0;
      RETURN NEW;
    END IF;
  END IF;

  -- Recompute discount (logic from 00175, sin cambios).
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

-- 3) P-CRIT-2: rollback trigger cuando un ride se cancela
CREATE OR REPLACE FUNCTION public.tg_rides_rollback_promo_on_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_use_existed BOOLEAN := false;
BEGIN
  -- Solo si el ride tenía promo aplicado.
  IF NEW.promo_code_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotency: solo rollback si efectivamente existía el promotion_use
  -- ligado a este ride. Re-cancelaciones o updates sin promo activo
  -- son no-op.
  DELETE FROM promotion_uses
  WHERE promotion_id = NEW.promo_code_id
    AND user_id = NEW.customer_id
    AND ride_id = NEW.id
  RETURNING true INTO v_use_existed;

  IF COALESCE(v_use_existed, false) THEN
    UPDATE promotions
    SET current_uses = GREATEST(current_uses - 1, 0)
    WHERE id = NEW.promo_code_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_rides_rollback_promo_on_cancel ON public.rides;
CREATE TRIGGER tg_rides_rollback_promo_on_cancel
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'canceled'::ride_status AND OLD.status <> 'canceled'::ride_status)
  EXECUTE FUNCTION public.tg_rides_rollback_promo_on_cancel();

-- 4) increment_promo_uses → no-op (compat backward, el trigger ya
--    hace el claim atómico). Las llamadas legacy del service-layer
--    quedan sin efecto pero sin error.
CREATE OR REPLACE FUNCTION public.increment_promo_uses(p_promo_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  -- Superseded by tg_rides_validate_promo_discount (00320) which
  -- atomically claims slots via UPDATE...WHERE current_uses<max_uses RETURNING.
  -- Kept as no-op for service-layer backward compat during deploy window.
  SELECT 1;
$$;

COMMENT ON FUNCTION public.tg_rides_validate_promo_discount() IS
  'P-CRIT-1/P-HIGH-4: BEFORE INSERT/UPDATE trigger que (a) valida promo state, (b) hace dedupe atómico por-user via UNIQUE en promotion_uses, (c) claim atómico del slot via UPDATE conditional, (d) zero seguro si cualquier check falla.';

COMMENT ON FUNCTION public.tg_rides_rollback_promo_on_cancel() IS
  'P-CRIT-2: AFTER UPDATE trigger que libera el slot del promo y borra promotion_uses cuando un ride se cancela.';

COMMENT ON FUNCTION public.increment_promo_uses(UUID) IS
  '00320 DEPRECATED: no-op kept for backward compat. Use tg_rides_validate_promo_discount trigger which now claims slots atomically on INSERT.';

COMMENT ON CONSTRAINT promotion_uses_ride_id_fkey ON promotion_uses IS
  '00320: DEFERRABLE INITIALLY DEFERRED — permite que el BEFORE INSERT trigger de rides referencie NEW.id antes del INSERT físico.';
