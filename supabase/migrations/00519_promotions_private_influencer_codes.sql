-- ============================================================
-- 00519: códigos privados (influencer / partner) + cierre de la
-- enumeración anónima del feed de promos.
--
-- Problema (auditoría del flujo de promo-code de admin, 2026-07-27):
-- no existía forma de emitir un código EXCLUSIVO. Todo código creado
-- desde el panel admin terminaba siendo público por tres vías:
--
--   1) `get_active_promotions` (00476) devuelve `code` y tenía
--      GRANT EXECUTE a `anon` → verificado en prod con
--      `SET LOCAL ROLE anon; SELECT code FROM get_active_promotions(20)`
--      → devolvió los 3 códigos activos + su descuento SIN login.
--      Eso reabre exactamente el agujero que 00321 (P-HIGH-6) cerró:
--      su comentario cita "INFLUENCER_KOL" como el caso a proteger.
--   2) El carrusel "PROMOS" del home (cliente + web) pinta el código
--      de toda promo activa a cualquier usuario logueado.
--   3) `notify_on_publish` (default true) dispara un push masivo al
--      activarla.
--
-- Fix (esta migración cubre 1 y 2; el 3 lo gatea la UI del admin):
--   a) Columna `promotions.is_public` (default true → las promos
--      existentes siguen siendo marketing público, sin cambio de
--      comportamiento).
--   b) `get_active_promotions` filtra `is_public = true`, así un
--      código privado NUNCA aparece en ningún feed.
--   c) REVOKE del grant a `anon`. Los dos únicos consumidores del RPC
--      (`apps/client` home y `apps/web` HomeDashboard) corren siempre
--      con sesión — HomeDashboard hace `if (!userId) return` — así que
--      quitar `anon` no rompe ninguna superficie viva.
--
-- Un código privado sigue siendo 100% canjeable: `validate_promo_code`
-- y el trigger `tg_rides_validate_promo_discount` NO miran `is_public`
-- — solo se lo saca del escaparate.
-- ============================================================

ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.promotions.is_public IS
  '00519: false = código privado (influencer/partner). Se excluye del feed get_active_promotions y del push masivo. Sigue siendo canjeable por quien lo conozca.';

CREATE OR REPLACE FUNCTION public.get_active_promotions(p_limit integer DEFAULT 6)
RETURNS TABLE (
  id uuid,
  code text,
  type text,
  discount_percent numeric,
  discount_fixed_cup integer,
  valid_until timestamptz,
  title_es text,
  body_es text,
  image_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p.id,
         p.code,
         p.type::text,
         p.discount_percent,
         p.discount_fixed_cup,
         p.valid_until,
         p.title_es,
         p.body_es,
         p.image_url
  FROM promotions p
  WHERE p.is_active = true
    -- 00519: los códigos privados no se publican en ningún feed.
    AND COALESCE(p.is_public, true) = true
    AND (p.valid_from IS NULL OR p.valid_from <= NOW())
    AND (p.valid_until IS NULL OR p.valid_until > NOW())
    AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
  ORDER BY p.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20);
$$;

REVOKE ALL ON FUNCTION public.get_active_promotions(integer) FROM PUBLIC;
-- 00519: `anon` queda FUERA. Enumerar códigos sin login era el vector
-- principal; ningún consumidor real lo necesita (ambos home son autenticados).
REVOKE EXECUTE ON FUNCTION public.get_active_promotions(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_active_promotions(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_promotions(integer) TO service_role;

COMMENT ON FUNCTION public.get_active_promotions(integer) IS
  '00519 (rev. 00476): feed marketing-safe de promos activas y PÚBLICAS para superficies de usuario autenticado. Los códigos privados (is_public=false) se excluyen. La tabla promotions es admin-only bajo RLS (00321).';
