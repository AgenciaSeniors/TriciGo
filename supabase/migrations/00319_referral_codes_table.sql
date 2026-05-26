-- ============================================================
-- R-CRIT-1: el sistema de referidos estaba funcionalmente roto:
--
-- 1) `getOrCreateReferralCode` usaba `userId.substring(0,8).toUpperCase()`
--    (8 hex chars = 2^32 espacio de claves → colisión esperable a
--    ~9300 users por birthday paradox).
--
-- 2) `applyReferralCode` resolvía code → referrer via
--    `SELECT id FROM users WHERE id ILIKE 'prefix%'`. Pero la RLS
--    `users_select_own` (00001:540) restringe SELECT a
--    `id = auth.uid() OR is_admin()`. → el ILIKE NUNCA matcheaba
--    el id de otro user → el feature siempre tiraba "Código
--    inválido" salvo cuando el user usaba su propio prefijo
--    (donde el self-referral check lo bloqueaba después). El
--    feature está **funcionalmente roto en producción** desde
--    Sprint 23.
--
-- 3) Aunque la RLS no estuviera (hipotético), un ILIKE con
--    prefijo de 8 chars hex puede devolver N matches → la query
--    tomaba `users[0]` arbitrariamente → referido al user
--    equivocado sin error.
--
-- Fix: tabla dedicada `referral_codes` con UNIQUE code y RPCs
-- SECURITY DEFINER para get/apply. Backfill preserva los códigos
-- UUID-prefix existentes (no rompe deep links ya compartidos).
-- Usuarios nuevos reciben códigos random 10-hex (2^40 espacio).
-- ============================================================

-- 1) Tabla referral_codes (1 código por user)
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_codes_code_format CHECK (code ~ '^[A-Z0-9]{6,16}$')
);

CREATE INDEX IF NOT EXISTS referral_codes_code_idx ON referral_codes (code);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

-- Read: cualquier authenticated puede resolver code → user_id
-- (los códigos son tokens públicos de share, no es secret material).
CREATE POLICY referral_codes_select_all ON referral_codes
  FOR SELECT TO authenticated USING (true);

-- Write: solo via RPC SECURITY DEFINER (o admin).
CREATE POLICY referral_codes_admin_all ON referral_codes
  FOR ALL TO authenticated USING (is_admin());

-- 2) RPC: get_or_create_referral_code → devuelve el código del caller
CREATE OR REPLACE FUNCTION public.get_or_create_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_code TEXT;
  v_attempts INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  -- Caso feliz: ya tiene código
  SELECT code INTO v_code FROM referral_codes WHERE user_id = v_user_id;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  -- Generar código random hasta evitar colisión (UNIQUE constraint)
  LOOP
    v_attempts := v_attempts + 1;
    v_code := upper(encode(gen_random_bytes(5), 'hex')); -- 10 hex chars
    BEGIN
      INSERT INTO referral_codes (user_id, code) VALUES (v_user_id, v_code);
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts > 5 THEN
        RAISE EXCEPTION 'Could not generate unique referral code after % attempts', v_attempts
          USING ERRCODE = 'P0009';
      END IF;
      -- retry con nuevo random
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_referral_code() TO authenticated;

-- 3) RPC: apply_referral_code → atómicamente resuelve + valida + inserta
CREATE OR REPLACE FUNCTION public.apply_referral_code(p_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_referee_id UUID := auth.uid();
  v_referrer_id UUID;
  v_referrer_active BOOLEAN;
  v_normalized_code TEXT;
  v_referral_id UUID;
BEGIN
  IF v_referee_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RAISE EXCEPTION 'Código de referido inválido' USING ERRCODE = 'P0001';
  END IF;

  v_normalized_code := upper(trim(p_code));

  -- Resolución equality (no ILIKE, no prefix): bug R-CRIT-1 eliminado
  SELECT rc.user_id, u.is_active
    INTO v_referrer_id, v_referrer_active
  FROM referral_codes rc
  JOIN users u ON u.id = rc.user_id
  WHERE rc.code = v_normalized_code;

  IF v_referrer_id IS NULL THEN
    RAISE EXCEPTION 'Código de referido inválido' USING ERRCODE = 'P0001';
  END IF;

  -- R-MED-7: rechazar si el referrer está suspended/baneado
  IF NOT COALESCE(v_referrer_active, false) THEN
    RAISE EXCEPTION 'Código de referido inválido' USING ERRCODE = 'P0001';
  END IF;

  IF v_referrer_id = v_referee_id THEN
    RAISE EXCEPTION 'No puedes usar tu propio código' USING ERRCODE = 'P0002';
  END IF;

  -- INSERT atómico: la UNIQUE en referee_id captura race de
  -- doble-click y devuelve error explícito. La race ya no produce
  -- "duplicate key" confuso porque mapeamos a P0003.
  BEGIN
    INSERT INTO referrals (referrer_id, referee_id, code, status, bonus_amount)
    VALUES (v_referrer_id, v_referee_id, v_normalized_code, 'pending', 500)
    RETURNING id INTO v_referral_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya usaste un código de referido' USING ERRCODE = 'P0003';
  END;

  RETURN v_referral_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_referral_code(TEXT) TO authenticated;

-- 4) Backfill: pre-popular códigos para users existentes preservando
-- el prefijo UUID histórico (no rompe deep links ya compartidos).
-- Colisiones (mismos primeros 8 chars) se saltan via ON CONFLICT —
-- esos users recibirán un código random al próximo
-- get_or_create_referral_code().
INSERT INTO referral_codes (user_id, code)
SELECT id, upper(left(id::TEXT, 8))
FROM users
ON CONFLICT DO NOTHING;

COMMENT ON TABLE referral_codes IS
  'R-CRIT-1: códigos de referido únicos. Reemplaza la resolución por UUID-prefix ILIKE rota por RLS.';
COMMENT ON FUNCTION public.apply_referral_code(TEXT) IS
  'R-CRIT-1: resolución atómica equality-based del referrer + INSERT con error codes mapeados (P0001 invalid, P0002 self, P0003 already-used).';
COMMENT ON FUNCTION public.get_or_create_referral_code() IS
  'R-CRIT-1: devuelve el código del caller (lazy create, 10 hex chars random con retry on collision).';
