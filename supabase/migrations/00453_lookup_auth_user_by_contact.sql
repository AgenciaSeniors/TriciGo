-- 00453_lookup_auth_user_by_contact.sql
-- Auditoría 2026-06-20 SEGUNDA FASE — AUD2-002 (P1, bloqueante de login a escala).
--
-- verify-otp resuelve el usuario existente con `supabase.auth.admin.listUsers()` SIN paginar
-- (default 50/página) y un `.find()` en memoria. Cuando `auth.users` pasa la primera página,
-- los usuarios de páginas siguientes NO se encuentran → la EF cae a `createUser` con el mismo
-- teléfono → colisión de teléfono → 500 "Failed to create account" → esos usuarios NO pueden
-- loguear. A escala de lanzamiento esto rompe el login de la mayoría.
--
-- Fix: un RPC SECURITY DEFINER que busca el usuario por teléfono/email con índice (auth.users tiene
-- índices únicos en phone + email) en O(1). Solo `service_role` (la EF usa el service key) — REVOKE
-- a anon/authenticated para que un usuario no enumere auth.users por teléfono.

CREATE OR REPLACE FUNCTION public.lookup_auth_user_by_contact(p_email text, p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT u.id
  FROM auth.users u
  WHERE (p_phone IS NOT NULL AND p_phone <> '' AND u.phone = p_phone)
     OR (p_email IS NOT NULL AND p_email <> '' AND u.email = p_email)
  -- preferir el match por teléfono (la identidad primaria del flujo OTP)
  ORDER BY (p_phone IS NOT NULL AND u.phone = p_phone) DESC NULLS LAST, u.created_at ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.lookup_auth_user_by_contact(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_auth_user_by_contact(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.lookup_auth_user_by_contact(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_auth_user_by_contact(text, text) TO service_role;

COMMENT ON FUNCTION public.lookup_auth_user_by_contact(text, text) IS
  '00453 AUD2-002: indexed auth.users lookup by phone/email for verify-otp (replaces unpaginated listUsers). service_role only (anti-enumeration).';
