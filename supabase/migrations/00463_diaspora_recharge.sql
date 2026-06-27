-- 00462: Diaspora recharge — public recipient resolution + payer metadata + flag.
--
-- A public (no-login) page lets someone abroad recharge a Cuban user's wallet
-- via Stripe. The recipient lookup MUST use the 00461-normalized matching (the
-- phone bug fix): this RPC reuses _normalize_cuban_phone on BOTH sides. Unlike
-- find_user_by_phone it has NO per-user rate-limit (the Edge Function rate-limits
-- per IP instead, since the public caller has no auth.uid()).

CREATE OR REPLACE FUNCTION public.find_recipient_for_recharge(p_phone text)
RETURNS TABLE(id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT u.id, u.full_name
  FROM users u
  WHERE public._normalize_cuban_phone(u.phone) = public._normalize_cuban_phone(p_phone)
    AND u.is_active = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.find_recipient_for_recharge(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_recipient_for_recharge(text) TO service_role;

-- Diaspora payer/source metadata (payer_email, source, masked recipient phone).
-- payment_intents had no generic metadata column; add a nullable jsonb one.
ALTER TABLE public.payment_intents ADD COLUMN IF NOT EXISTS metadata jsonb;

-- Feature flag (feature_flags.value is BOOLEAN). Default OFF until Stripe is live.
INSERT INTO public.feature_flags (key, value, description)
VALUES ('diaspora_recharge_enabled', false, 'Public diaspora wallet-recharge page (/recargar) via Stripe')
ON CONFLICT (key) DO NOTHING;
