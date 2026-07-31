-- ============================================================
-- 00530 — users.phone: la cadena vacía deja de ser un teléfono válido
--
-- CONTEXTO
-- public.users.phone era NOT NULL desde que el alta por OTP era el único
-- camino de registro (ahí auth.users.phone siempre venía lleno). Cuando se
-- sumó el alta por email/Google/Apple, auth.users.phone quedó NULL para esos
-- usuarios y handle_new_user() tuvo que inventar un valor que satisficiera la
-- restricción:
--
--     COALESCE(NEW.phone, '')
--
-- No fue un descuido: con la columna en NOT NULL el trigger no tenía otra
-- opción. Pero la cadena vacía es peor que NULL — pasa cualquier chequeo
-- IS NOT NULL, y solo se comporta como "sin teléfono" por accidente (es falsy
-- en JavaScript). Medido el 2026-07-31: 45 filas así (42 pasajeros, 1 admin,
-- 2 super_admin), 41 de ellas de altas OAuth, la más vieja del 2026-03-10.
--
-- QUÉ HACE
--   1. Permite NULL en la columna.
--   2. Pasa las 45 filas existentes de '' a NULL.
--   3. Agrega un CHECK que impide reinsertar cadenas vacías o en blanco.
--   4. handle_new_user() escribe NULL en vez de ''.
--
-- POR QUÉ ES SEGURO (verificado contra prod ANTES de escribir esto)
--   - No hay índice único ni FK sobre phone (solo PK sobre id).
--   - Los guards SQL que comparan phone con '' YA contemplan NULL de forma
--     explícita, así que no aplica la trampa de lógica ternaria (NULL <> ''
--     evalúa a desconocido, no a verdadero):
--       auto_link_fleet_member_on_signup → IF NEW.phone IS NULL OR NEW.phone = ''
--       tg_users_normalize_phone         → IF NEW.phone IS NOT NULL AND NEW.phone <> ''
--       lookup_auth_user_by_contact      → filtra sobre auth.users y sobre su
--                                          parámetro, nunca sobre esta columna
--   - tg_users_protect_admin_fields no toca phone en ninguna de sus ramas.
--   - Los gates de perfil incompleto (apps/client/app/_layout.tsx y
--     apps/web/src/app/providers.tsx) usan comparación falsy (!user.phone),
--     que trata '' y NULL igual → el redirect a /verify-phone sigue igual.
--   - Antes de aplicar: 0 filas con solo espacios y 0 fuera de E.164 entre las
--     no vacías, así que el CHECK no puede chocar con datos existentes.
--
-- FUERA DE ALCANCE (deliberado)
--   users.full_name tiene el mismo patrón (NOT NULL DEFAULT '') y lo escribe
--   el mismo trigger. No se toca acá para mantener el cambio acotado a una
--   sola columna; si se quiere, va en su propia migración.
-- ============================================================

-- ── 1. Permitir NULL ────────────────────────────────────────
ALTER TABLE public.users ALTER COLUMN phone DROP NOT NULL;

-- ── 2. Backfill: '' y blancos → NULL (idempotente) ──────────
UPDATE public.users
SET    phone = NULL
WHERE  phone IS NOT NULL
  AND  btrim(phone) = '';

-- ── 3. Impedir que vuelva a entrar una cadena vacía ─────────
-- NOT VALID no hace falta: acabamos de dejar la tabla limpia, así que la
-- validación inmediata no puede fallar y el CHECK queda ya aplicado a todo.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_phone_not_blank;
ALTER TABLE public.users
  ADD CONSTRAINT users_phone_not_blank
  CHECK (phone IS NULL OR btrim(phone) <> '');

COMMENT ON CONSTRAINT users_phone_not_blank ON public.users IS
  '00530: "sin teléfono" se representa con NULL, nunca con la cadena vacía. '
  'La cadena vacía pasaba los chequeos IS NOT NULL y solo se comportaba como '
  '"sin teléfono" porque es falsy en JavaScript.';

-- ── 4. handle_new_user: NULL en vez de '' ───────────────────
-- Cuerpo reproducido de la versión VIVA en prod (pg_get_functiondef) con un
-- único cambio: COALESCE(NEW.phone, '') → NULLIF(NEW.phone, '').
-- Se usa NULLIF y no NEW.phone a secas para cubrir también el caso en que
-- GoTrue entregue la cadena vacía en vez de NULL.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.users (id, phone, full_name, email, role)
  VALUES (
    NEW.id,
    NULLIF(NEW.phone, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE WHEN NEW.email ~* '^phone_\d+@tricigo\.app$' THEN NULL ELSE NEW.email END,
    'customer'
  );
  RETURN NEW;
END;
$function$;
