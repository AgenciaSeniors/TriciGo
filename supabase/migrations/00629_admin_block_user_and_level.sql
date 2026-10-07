-- ============================================================
-- 00629 — "Bloquear usuario" blocks for real; the level override works
--
-- WHY (admin panel audit, 2026-10-07)
--   The panel's block and level buttons did nothing. adminService wrote
--   users.is_active / users.level with a plain UPDATE, and users has no UPDATE
--   policy for admins (only users_update_own), so PostgREST touched 0 rows and
--   the page said "Usuario bloqueado". Even a working UPDATE would not have
--   blocked anyone: users.is_active only hides an account from phone and
--   gift-code lookups. Login, token refresh, the apps, going online and
--   accepting rides never look at it (find_best_drivers and accept_ride_v2
--   included).
--
-- WHAT
--   1. admin_set_user_active(user, active, reason): one audited call.
--      Block: users.is_active = false; auth.users.banned_until 100 years ahead
--      (GoTrue then refuses every login, OTP/Google/Apple/link, and every token
--      refresh); every session and refresh token deleted; a driver taken
--      offline with auto_offline_at cleared, so driver_heartbeat cannot bring
--      them back. Unblock: is_active = true and the ban lifted.
--      Who: any admin, with a reason to block. Never yourself, never the two
--      system accounts (00604 keeps them banned), and only a super_admin may
--      block an admin.
--   2. A blocked driver stays offline: a BEFORE UPDATE OF is_online trigger
--      keeps is_online false for an inactive account. An access token already
--      issued stays valid until it expires (Supabase default: 1 hour), and the
--      apps can still write their own rows with it; this closes the one write
--      that matters in that hour, going back online to take rides.
--   3. admin_set_user_level(user, level): only a super_admin, which is what
--      tg_users_protect_admin_fields already allows (it puts level back for
--      admins). Audited with the old and new level.
--
-- ROLLOUT
--   Apply before the panel deploy: the new panel calls these functions.
-- ============================================================

SET lock_timeout = '5s';

-- 1. Block / unblock.
CREATE OR REPLACE FUNCTION public.admin_set_user_active(p_user_id uuid, p_active boolean, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     public.user_role;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_sessions integer := 0;
BEGIN
  IF v_caller IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador puede bloquear o desbloquear cuentas.', DETAIL = 'not_admin';
  END IF;
  IF p_user_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Faltan datos para cambiar el estado de la cuenta.', DETAIL = 'missing_argument';
  END IF;
  IF p_user_id = v_caller THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'No puedes bloquear tu propia cuenta.', DETAIL = 'self';
  END IF;
  -- ...0001 owns the platform wallets and ...0099 the anonymized rows; 00604
  -- banned both until 2999. Unblocking either would lift that ban.
  IF p_user_id IN ('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000099'::uuid) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Las cuentas del sistema no se pueden bloquear ni desbloquear.', DETAIL = 'system_account';
  END IF;

  SELECT u.role INTO v_role FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'La cuenta no existe.', DETAIL = 'not_found';
  END IF;
  IF v_role IN ('admin', 'super_admin') AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un super admin puede bloquear o desbloquear a otro administrador.', DETAIL = 'target_is_staff';
  END IF;
  IF NOT p_active AND v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Escribe el motivo del bloqueo.', DETAIL = 'reason_required';
  END IF;

  IF p_active THEN
    UPDATE public.users SET is_active = true WHERE id = p_user_id;
    UPDATE auth.users SET banned_until = NULL WHERE id = p_user_id;
  ELSE
    UPDATE public.users SET is_active = false WHERE id = p_user_id;
    -- GoTrue refuses the login and the token refresh of a banned user. 100
    -- years is what GoTrue itself stores for its longest ban ('876000h').
    UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = p_user_id;
    WITH s AS (DELETE FROM auth.sessions WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_sessions FROM s;
    -- Refresh tokens with a session went with it (ON DELETE CASCADE); these
    -- are the ones without one.
    DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
    UPDATE public.driver_profiles SET is_online = false, auto_offline_at = NULL
    WHERE user_id = p_user_id AND (is_online OR auto_offline_at IS NOT NULL);
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (v_caller, CASE WHEN p_active THEN 'unblock_user' ELSE 'block_user' END,
          'user', p_user_id::text, v_reason);

  RETURN jsonb_build_object('user_id', p_user_id, 'is_active', p_active, 'sessions_closed', v_sessions);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_user_active(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_active(uuid, boolean, text) TO authenticated, service_role;

-- 2. A blocked driver stays offline.
CREATE OR REPLACE FUNCTION public.tg_driver_profiles_inactive_stays_offline()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.is_online AND NOT OLD.is_online
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND NOT u.is_active) THEN
    NEW.is_online := false;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_driver_profiles_inactive_stays_offline() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_driver_profiles_inactive_stays_offline ON public.driver_profiles;
CREATE TRIGGER trg_driver_profiles_inactive_stays_offline
  BEFORE UPDATE OF is_online ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_profiles_inactive_stays_offline();

-- 3. Level override, super_admin only.
CREATE OR REPLACE FUNCTION public.admin_set_user_level(p_user_id uuid, p_level public.user_level)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_old    public.user_level;
BEGIN
  IF v_caller IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un super admin puede cambiar el nivel de una cuenta.', DETAIL = 'not_super_admin';
  END IF;
  IF p_user_id IS NULL OR p_level IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'Faltan datos para cambiar el nivel.', DETAIL = 'missing_argument';
  END IF;

  SELECT u.level INTO v_old FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'La cuenta no existe.', DETAIL = 'not_found';
  END IF;

  UPDATE public.users SET level = p_level WHERE id = p_user_id;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (v_caller, 'set_user_level', 'user', p_user_id::text, v_old::text || ' → ' || p_level::text);

  RETURN jsonb_build_object('user_id', p_user_id, 'level', p_level, 'previous_level', v_old);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_user_level(uuid, public.user_level) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_level(uuid, public.user_level) TO authenticated, service_role;

-- Pasted into the SQL Editor from Windows, the bodies above carry \r\n line
-- ends: they work, but no longer match git. Recreate them without the \r
-- (CREATE OR REPLACE keeps their grants).
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.admin_set_user_active(uuid, boolean, text)'::regprocedure,
    'public.tg_driver_profiles_inactive_stays_offline()'::regprocedure,
    'public.admin_set_user_level(uuid, public.user_level)'::regprocedure]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- Assert the end state.
DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.admin_set_user_active(uuid, boolean, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_set_user_level(uuid, public.user_level)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid IN ('public.admin_set_user_active(uuid, boolean, text)'::regprocedure,
                                'public.admin_set_user_level(uuid, public.user_level)'::regprocedure)
                  AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '00629: anon or PUBLIC can execute the block or level functions';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_set_user_active(uuid, boolean, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_set_user_level(uuid, public.user_level)', 'EXECUTE') THEN
    RAISE EXCEPTION '00629: the panel (authenticated) cannot call the block or level functions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.driver_profiles'::regclass
                   AND tgname = 'trg_driver_profiles_inactive_stays_offline'
                   AND tgenabled = 'O'
                   AND tgfoid = 'public.tg_driver_profiles_inactive_stays_offline()'::regprocedure) THEN
    RAISE EXCEPTION '00629: the stay-offline trigger is missing or disabled';
  END IF;
END
$check$;

RESET lock_timeout;
