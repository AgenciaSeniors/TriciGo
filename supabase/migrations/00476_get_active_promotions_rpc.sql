-- 00476: get_active_promotions — user-facing read path for the promos feed.
--
-- Problem (P1-1, marketing audit 2026-07-02): the mobile home carousel and the
-- web HomeDashboard read `.from('promotions')` with the user's client, but
-- migration 00321 (P-HIGH-6) removed the public SELECT policy — the only
-- remaining policy is `promo_admin` (is_admin()). Verified in prod with role
-- simulation: an authenticated customer sees 0 rows, so the PROMOS section
-- never renders and no user can discover a code in-app (0 redemptions ever).
--
-- Fix: a SECURITY DEFINER RPC that exposes ONLY marketing-safe fields of
-- promotions that are active, inside their validity window and with remaining
-- uses. It does NOT expose current_uses / max_uses / notify_on_publish /
-- created_by, so the RLS lockdown of 00321 stays meaningful.
--
-- Codes are public marketing material by design (the admin broadcasts them
-- via push), so `anon` is granted too — the web home can show promos to
-- logged-out visitors if it ever wants to.

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
    AND (p.valid_from IS NULL OR p.valid_from <= NOW())
    AND (p.valid_until IS NULL OR p.valid_until > NOW())
    AND (p.max_uses IS NULL OR p.current_uses < p.max_uses)
  ORDER BY p.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20);
$$;

REVOKE ALL ON FUNCTION public.get_active_promotions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_promotions(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_promotions(integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_active_promotions(integer) TO service_role;

COMMENT ON FUNCTION public.get_active_promotions(integer) IS
  '00476: marketing-safe feed of active promos for user-facing surfaces. The promotions table is admin-only under RLS (00321) — client feeds must use this RPC.';
