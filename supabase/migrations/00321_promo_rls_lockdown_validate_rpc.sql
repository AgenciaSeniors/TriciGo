-- ============================================================
-- P-HIGH-6: la tabla `promotions` tenía RLS policy `promo_select`
-- (00001:609) que permitía `SELECT` a CUALQUIER user authenticated
-- sobre TODAS las promociones activas dentro de la ventana
-- valid_from/valid_until. Esto es enumeración de códigos secretos:
--
-- ```sql
-- SELECT code, type, discount_percent, discount_fixed_cup
-- FROM promotions
-- WHERE is_active = true AND valid_from <= NOW()
--   AND (valid_until IS NULL OR valid_until > NOW());
-- ```
--
-- Un user malicioso puede listar todas las promos activas
-- (incluyendo campañas selectivas tipo "B2B_PARTNER_50OFF",
-- "INFLUENCER_KOL", "STAFF_FRIENDS") y aplicarlas a sus rides
-- sin que el admin sepa.
--
-- `ride.service.ts:validatePromoCode` también consultaba la tabla
-- directamente con `.from('promotions').select('*')` — expone
-- todas las columnas (discount_percent, max_uses, valid_until,
-- created_by, etc.) al cliente.
--
-- Fix:
-- 1) Drop policy `promo_select` (queda solo `promo_admin` para is_admin).
-- 2) Nueva RPC `validate_promo_code(p_code, p_user_id, p_fare_amount)`
--    SECURITY DEFINER que:
--    - busca por code (ILIKE para case-insensitive)
--    - valida is_active + valid_from + valid_until + max_uses
--    - chequea `promotion_uses` per-user (ya usado)
--    - calcula el discount según el type
--    - devuelve solo: { valid, promotion_id, code, discount_amount,
--      error_reason } — sin filtrar columnas internas.
-- 3) Client-layer (ride.service.ts) reemplaza `.from('promotions')`
--    por la RPC.
-- ============================================================

-- 1) Drop the leaky SELECT policy. Solo admins pueden leer la tabla
--    directamente; los users authenticated van por la RPC.
DROP POLICY IF EXISTS "promo_select" ON public.promotions;

-- 2) RPC validate_promo_code → returns JSON con resultado de validación
CREATE OR REPLACE FUNCTION public.validate_promo_code(
  p_code TEXT,
  p_user_id UUID,
  p_fare_amount INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
STABLE
AS $$
DECLARE
  v_promo RECORD;
  v_already_used BOOLEAN := false;
  v_discount INTEGER := 0;
  v_type TEXT;
  v_normalized TEXT := upper(trim(COALESCE(p_code, '')));
BEGIN
  -- Auth gate: only logged-in users can validate.
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'unauthenticated');
  END IF;

  -- p_user_id debe coincidir con el caller. Evita que un user
  -- chequee el estado del promo en nombre de otro.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'forbidden');
  END IF;

  IF length(v_normalized) = 0 THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  -- Lookup por code case-insensitive.
  SELECT * INTO v_promo
  FROM promotions
  WHERE upper(code) = v_normalized
    AND is_active = true
  LIMIT 1;

  IF v_promo IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  -- Ventana valid_from / valid_until.
  IF v_promo.valid_from > NOW() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'invalid');
  END IF;

  IF v_promo.valid_until IS NOT NULL AND v_promo.valid_until <= NOW() THEN
    RETURN jsonb_build_object('valid', false, 'error', 'expired');
  END IF;

  -- max_uses agotado.
  IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'error', 'max_uses');
  END IF;

  -- Per-user dedupe.
  SELECT EXISTS (
    SELECT 1 FROM promotion_uses
    WHERE promotion_id = v_promo.id AND user_id = p_user_id
  ) INTO v_already_used;

  IF v_already_used THEN
    RETURN jsonb_build_object('valid', false, 'error', 'already_used');
  END IF;

  -- Compute discount. Kept in sync con el trigger
  -- tg_rides_validate_promo_discount (00175 + 00320).
  v_type := v_promo.type::TEXT;
  IF v_type IN ('percentage_discount', 'bonus_credit') THEN
    v_discount := LEAST(
      ROUND(COALESCE(p_fare_amount, 0) * COALESCE(v_promo.discount_percent, 0) / 100.0)::INTEGER,
      COALESCE(p_fare_amount, 0)
    );
  ELSIF v_type = 'fixed_discount' THEN
    v_discount := LEAST(
      COALESCE(v_promo.discount_fixed_cup, 0),
      COALESCE(p_fare_amount, 0)
    );
  END IF;

  v_discount := GREATEST(v_discount, 0);

  RETURN jsonb_build_object(
    'valid', true,
    'promotion_id', v_promo.id,
    'code', v_promo.code,
    'type', v_type,
    'discount_amount', v_discount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_promo_code(TEXT, UUID, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.validate_promo_code(TEXT, UUID, INTEGER) IS
  'P-HIGH-6: validación server-side de promo codes sin exponer la tabla `promotions` al client. Devuelve solo discount + promotion_id + error reason.';
