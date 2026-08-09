-- 00558_partner_places_discount_model.sql
--
-- Los lugares aliados dejan de ser "cupón que se canjea en el mostrador" y pasan
-- a ser "destinos con tarifa descontada". Cambia quién paga el beneficio:
--
--   ANTES (00532-00536): el NEGOCIO absorbía el beneficio. TriciGo solo emitía
--     un cupón de un solo uso al terminar el viaje ahí, y el negocio lo canjeaba
--     en una página pública. Cero movimiento de dinero en la plataforma.
--
--   AHORA: el descuento lo pone LA PLATAFORMA y sale de su comisión. El pasajero
--     paga `tarifa − porcentaje`, el conductor cobra igual que siempre (sobre la
--     tarifa completa, vía el subsidio de 00481), y la comisión de la plataforma
--     en ese viaje pasa a ser `comisión − descuento`.
--
-- El invariante que sostiene el modelo: el descuento se topea en la comisión
-- efectiva del viaje, así que la plataforma resigna comisión pero NUNCA pone
-- plata propia. Con tarifa F, comisión c y descuento d:
--     neto plataforma = F(1−d)·c − F(1−c)·d = F(c−d) ≥ 0  ⟺  d ≤ c
-- Ese tope se aplica en 00559 (trigger) y 00560 (subsidio), no acá.
--
-- Seguro de aplicar sin migrar datos: al escribirse esta migración había 0 filas
-- en partner_places y 0 en partner_coupons — la función nunca llegó a emitir un
-- cupón real. Si eso cambió, PARAR: hay pasajeros con cupones vivos.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Abajo el mostrador: emisión, canje y recordatorio
-- ─────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_rides_issue_partner_coupons ON public.rides;
DROP FUNCTION IF EXISTS public.tg_rides_issue_partner_coupons();

DROP FUNCTION IF EXISTS public.validate_partner_coupon(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.redeem_partner_coupon(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.redeem_own_partner_coupon(UUID);
DROP FUNCTION IF EXISTS public.get_my_partner_coupons();
DROP FUNCTION IF EXISTS public.notify_expiring_partner_coupons();
DROP FUNCTION IF EXISTS public._generate_coupon_code();
DROP FUNCTION IF EXISTS public._normalize_coupon_code(TEXT);
DROP FUNCTION IF EXISTS public._coupon_rate_limit_ok(TEXT);

DO $$
BEGIN
  PERFORM cron.unschedule('partner-coupon-reminder');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- no estaba programado
END $$;

DROP TABLE IF EXISTS public.partner_coupons;

-- Estas tres devuelven o consumen columnas que se eliminan más abajo. Se dropean
-- acá y se recrean en 00561 sobre el modelo nuevo. Dropearlas en vez de dejarlas
-- rotas hace que un llamador desactualizado falle con "function does not exist"
-- —diagnóstico obvio— en lugar de un error de columna inexistente.
-- Aplicar 00561 inmediatamente después: en el medio el panel admin no lista.
DROP FUNCTION IF EXISTS public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT);
DROP FUNCTION IF EXISTS public.admin_list_partner_places();
DROP FUNCTION IF EXISTS public.admin_upsert_partner_place(
  UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ);

-- ─────────────────────────────────────────────────────────────────────
-- 2. El lugar ya no ofrece un beneficio en especie: ofrece un porcentaje
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.partner_places
  DROP COLUMN IF EXISTS benefit_title,
  DROP COLUMN IF EXISTS benefit_description,
  DROP COLUMN IF EXISTS terms,
  DROP COLUMN IF EXISTS coupon_ttl_minutes,
  DROP COLUMN IF EXISTS cooldown_days,
  DROP COLUMN IF EXISTS validation_token;

ALTER TABLE public.partner_places
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 10
    CHECK (discount_percent > 0 AND discount_percent <= 100),
  -- Línea corta y opcional bajo el nombre en el carrusel ("Panadería artesanal").
  -- Reemplaza a benefit_description, que ahora no tiene sentido: el beneficio
  -- es el porcentaje y se muestra como badge.
  ADD COLUMN IF NOT EXISTS tagline TEXT;

-- partner_places NO tiene grant de tabla para `authenticated`: se otorgan las
-- columnas no secretas una por una (así se mantenía ilegible validation_token).
-- Una columna nueva sin grant explícito queda INVISIBLE para el cliente.
GRANT SELECT (discount_percent, tagline) ON public.partner_places TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Atribución en el viaje: qué lugar lo generó y cuánto se resignó
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS partner_place_id UUID
    REFERENCES public.partner_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_discount_cup INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS rides_partner_place_idx
  ON public.rides (partner_place_id) WHERE partner_place_id IS NOT NULL;

COMMENT ON COLUMN public.rides.partner_discount_cup IS
  '00558 Descuento de lugar aliado REALMENTE aplicado, en CUP. Vale 0 si ganó el promo (gana el mayor, no se suman). Lo escribe el trigger tg_rides_validate_promo_discount; el cliente nunca lo manda.';
COMMENT ON COLUMN public.rides.partner_place_id IS
  '00558 Lugar aliado que originó el descuento, o NULL. Sirve para medir qué cuesta cada acuerdo.';
COMMENT ON COLUMN public.partner_places.discount_percent IS
  '00558 Porcentaje sobre la tarifa. Se topea en la comisión efectiva del viaje al aplicarse: ese tope es lo que impide que la plataforma ponga plata propia.';
COMMENT ON TABLE public.partner_places IS
  '00558 Negocios aliados: terminar un viaje acá descuenta la tarifa. Lo absorbe la PLATAFORMA desde su comisión (antes de 00558 lo absorbía el negocio con un cupón).';

-- NOTA: no se toca notifications_type_check. Sacar 'partner_coupon' del CHECK no
-- aporta nada y fallaría si quedara alguna notificación histórica con ese tipo.
