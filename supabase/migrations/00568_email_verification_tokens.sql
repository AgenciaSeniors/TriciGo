-- 00568: Tokens propios para verificar el correo de respaldo (sin sesión implícita)
--
-- CONTEXTO (auditoría del PR #960, 2026-08-17). El login por correo destapó una
-- cadena rota en la verificación:
--   1. add-email-with-verification mandaba un MAGIC LINK como "link de
--      verificación" — un link que MINTEA SESIÓN. Si el conductor tipeaba mal su
--      correo, el dueño real de esa casilla recibía un enlace que le abría la
--      cuenta del conductor con un click.
--   2. El paso 4 de su propio comment ("EF aparte marca email_verified_at")
--      NUNCA se construyó: cero código escribe users.email_verified_at con un
--      timestamp. request-password-reset ya gateaba en ese flag → los resets de
--      contraseña para correos agregados por esa EF jamás salieron.
--   3. El redirect del link apuntaba a /auth/email-confirmed, página que no
--      existía (404).
--   4. send-login-email-link (00567-era) mandaba enlaces de acceso sin exigir
--      verificación — combinado con (1), un typo era una toma de cuenta.
--
-- ESTA MIGRACIÓN aporta la pieza de datos: tokens de verificación PROPIOS, de un
-- solo uso, que NO mintean sesión. El click solo prueba posesión del buzón; la
-- EF confirm-email lo canjea y estampa users.email_verified_at, del que ahora
-- gatean tanto send-login-email-link como (desde siempre) request-password-reset.
--
-- POR QUÉ NO el email_confirmed_at de GoTrue como gate: la Estrategia B de
-- verify-otp (generateLink+verifyOtp server-side en cada login SMS cuyo password
-- grant falle) puede marcarlo SIN que el dueño del buzón haya clickeado jamás.
-- El flag propio solo lo escribe confirm-email tras canjear un token real.

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  -- Se guarda el sha256 hex del token, nunca el token: un dump de la tabla no
  -- alcanza para confirmar nada.
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON email_verification_tokens (user_id);

-- Tabla-candado (patrón otp_codes/rate_limits): RLS activo SIN policies —
-- solo el service-role de las EFs la toca. El advisor rls_enabled_no_policy
-- la va a listar; es intencional, como sus hermanas.
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE email_verification_tokens IS
  '00568: tokens de un solo uso para verificar el correo de respaldo. Los emite '
  'add-email-with-verification (24h TTL, uno vivo por usuario) y los canjea '
  'confirm-email, que estampa users.email_verified_at — el gate de '
  'send-login-email-link y request-password-reset. Sin cron de limpieza: las '
  'EFs borran los vencidos del propio usuario al emitir/canjear (≤1 fila viva '
  'por usuario, la tabla no crece).';
