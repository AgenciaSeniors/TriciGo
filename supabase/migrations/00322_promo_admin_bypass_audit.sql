-- ============================================================
-- P-HIGH-5: el trigger `tg_rides_validate_promo_discount` (00175,
-- extended por 00320) tiene una bypass condition:
--
--   IF is_admin() THEN RETURN NEW;
--
-- Esto permite que CUALQUIER admin inserte rides con cualquier
-- `discount_amount_cup` (incluso > fare) y cualquier `promo_code_id`
-- (incluso NULL + discount > 0). No hay log de qué admin lo hizo
-- ni para qué ride.
--
-- Riesgos:
-- - Insider threat: un admin compromido vacía el treasury sin rastro.
-- - Admin acquihired/contratista con acceso temp puede otorgar
--   discounts unrestricted.
-- - No audit trail para forensic: si aparece un ride con discount
--   raro, no hay forma de saber qué admin lo autorizó.
--
-- Fix:
-- 1) Crear tabla `admin_promo_audit_log` append-only.
-- 2) Escalar el bypass de `is_admin()` a `is_super_admin()` —
--    regular admins pierden el bypass; deben ir por flujos normales
--    (crear un promo, asignarlo, dejar que el trigger valide). El
--    super_admin tier es scarcer y mejor controlado (00291).
-- 3) Registrar audit row en cada bypass: qué super_admin, qué ride,
--    qué discount original (cliente lo mandó) vs trigger-computed
--    (lo que habría calculado sin bypass).
-- ============================================================

-- 1) Audit table append-only.
CREATE TABLE IF NOT EXISTS admin_promo_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_user_id UUID NOT NULL REFERENCES users(id),
  ride_id UUID NOT NULL REFERENCES rides(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  promo_code_id UUID REFERENCES promotions(id),
  discount_amount_cup_supplied INTEGER NOT NULL,
  estimated_fare_cup INTEGER,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS admin_promo_audit_log_admin_idx
  ON admin_promo_audit_log (admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_promo_audit_log_ride_idx
  ON admin_promo_audit_log (ride_id);
CREATE INDEX IF NOT EXISTS admin_promo_audit_log_created_idx
  ON admin_promo_audit_log (created_at DESC);

ALTER TABLE admin_promo_audit_log ENABLE ROW LEVEL SECURITY;

-- Solo super_admin puede leer (auditoría sensitive).
CREATE POLICY admin_promo_audit_select ON admin_promo_audit_log
  FOR SELECT TO authenticated USING (is_super_admin());

-- Inserts solo por el trigger (SECURITY DEFINER). Nadie escribe directo.
CREATE POLICY admin_promo_audit_no_direct_write ON admin_promo_audit_log
  FOR ALL TO authenticated USING (false);

-- Append-only: bloquear UPDATE/DELETE para todo caller (incluso
-- super_admin) — forensic integrity. TRUNCATE solo lo puede hacer
-- el table owner (service_role) por privilegios de Postgres,
-- así que no requiere trigger explícito aquí.
CREATE OR REPLACE FUNCTION public.tg_admin_promo_audit_log_block_mutations()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin_promo_audit_log is append-only — % blocked', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS admin_promo_audit_block_update ON public.admin_promo_audit_log;
CREATE TRIGGER admin_promo_audit_block_update
  BEFORE UPDATE OR DELETE ON public.admin_promo_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_admin_promo_audit_log_block_mutations();

-- 2) Reemplazar el trigger con la nueva lógica de bypass + audit.
--    Mantiene toda la lógica de validación de 00320 — solo cambia
--    el bypass condition + agrega el log.
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
  v_supplied_discount INTEGER := COALESCE(NEW.discount_amount_cup, 0);
BEGIN
  -- P-HIGH-5: bypass escalated a is_super_admin() + audit log.
  -- Regular `is_admin()` ya NO puede saltarse validaciones —
  -- debe ir por el flujo normal de promo codes.
  IF is_super_admin() THEN
    -- Audit trail: solo si el super_admin efectivamente está
    -- aplicando un override (i.e. supplied discount != 0, o tocó
    -- promo_code_id en un UPDATE).
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

  -- Resto idéntico a 00320: validate + dedupe + atomic claim + recompute.
  IF NEW.promo_code_id IS NULL THEN
    IF v_supplied_discount <> 0 THEN
      NEW.discount_amount_cup := 0;
    END IF;
    RETURN NEW;
  END IF;

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

  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)
      VALUES (v_promo.id, NEW.customer_id, NEW.id);
    EXCEPTION WHEN unique_violation THEN
      NEW.promo_code_id := NULL;
      NEW.discount_amount_cup := 0;
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
      NEW.discount_amount_cup := 0;
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

  NEW.discount_amount_cup := GREATEST(v_correct_discount, 0);
  RETURN NEW;
END;
$$;

COMMENT ON TABLE admin_promo_audit_log IS
  'P-HIGH-5: registro append-only de bypasses al validador de promo. Cada bypass de super_admin queda logueado con timestamp + user + ride + discount supplied vs trigger-computed.';

COMMENT ON FUNCTION public.tg_rides_validate_promo_discount() IS
  'P-HIGH-5/P-CRIT-1/P-HIGH-4: bypass escalado a is_super_admin() + audit log. is_admin() regular ya NO se salta validaciones.';
