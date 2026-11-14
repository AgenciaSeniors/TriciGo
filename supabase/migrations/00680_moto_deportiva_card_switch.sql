-- 00680: Moto Deportiva — panel switch to show or hide the card in the apps.
--
-- Hidden ("Oculta"): the apps get status 'hidden' in every state, also with a pilot online,
-- so the card disappears from the passenger app and the web. The insert guard of 00679 reads
-- get_moto_deportiva_status(), so it rejects new orders too, and no Avísame notice goes out.
-- This is separate from Activar/Desactivar (service_type_configs.is_active), which leaves the
-- card greyed with "Avísame". Subscribers stay subscribed while the card is hidden.
--
-- The comment inside tg_rides_moto_deportiva_guard (00679) says get_moto_deportiva_status()
-- "never hides 'available'": since 00680 it does when the card is hidden, which is what makes
-- the guard reject. The guard's body is not touched.
--
-- Patches (md5-guarded, from the live body): get_moto_deportiva_status (rewritten),
-- _moto_deportiva_send_notice and admin_moto_deportiva_overview (one line each).
-- New: _moto_deportiva_card_visible(), admin_set_moto_deportiva_visible(boolean).

INSERT INTO public.platform_config (key, value) VALUES ('moto_deportiva_card_visible', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Helper ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._moto_deportiva_card_visible()
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v boolean;
BEGIN
  SELECT (value #>> '{}') NOT IN ('false', 'f') INTO v
    FROM public.platform_config WHERE key = 'moto_deportiva_card_visible';
  RETURN COALESCE(v, true);
END
$function$;
REVOKE ALL ON FUNCTION public._moto_deportiva_card_visible() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._moto_deportiva_card_visible() TO service_role;

-- ── Guards on the bodies this migration replaces or patches ──
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_moto_deportiva_status()'::regprocedure;
  IF v_md5 NOT IN ('fa52d473f889fe4b75468c0faf19d7a8', '637758198156c3968273a11ed25252e0') THEN
    RAISE EXCEPTION '00680: get_moto_deportiva_status has an unknown body (md5 %)', v_md5;
  END IF;
END
$guard$;

-- ── Status for the apps ──────────────────────────────────────
-- {status: hidden|off|offline|busy|available, waiting: bool}. Never positions or ids.
CREATE OR REPLACE FUNCTION public.get_moto_deportiva_status()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_show boolean;
  v_status text;
  v_waiting boolean := false;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_waiting := EXISTS (SELECT 1 FROM public.moto_deportiva_waitlist WHERE user_id = auth.uid());
  END IF;
  -- 00680: the panel hid the card: hidden in every state (the insert guard rejects on it).
  IF NOT public._moto_deportiva_card_visible() THEN
    RETURN jsonb_build_object('status', 'hidden', 'waiting', v_waiting);
  END IF;
  v_status := public._moto_deportiva_raw_status();
  IF v_status <> 'available' THEN
    SELECT (value #>> '{}') NOT IN ('false', 'f') INTO v_show
      FROM public.platform_config WHERE key = 'moto_deportiva_show_when_unavailable';
    IF NOT COALESCE(v_show, true) THEN v_status := 'hidden'; END IF;
  END IF;
  RETURN jsonb_build_object('status', v_status, 'waiting', v_waiting);
END
$function$;
REVOKE ALL ON FUNCTION public.get_moto_deportiva_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_moto_deportiva_status() TO anon, authenticated, service_role;

-- ── One-line patches ─────────────────────────────────────────
DO $patch$
DECLARE v_md5 text; v_src text; v_new text;
BEGIN
  -- No Avísame notice while the card is hidden.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public._moto_deportiva_send_notice(text)'::regprocedure;
  IF v_md5 NOT IN ('b2e59c4ace99a3d5973c4c57f026ff07', '5dc8024a840071e107285829c081ec72') THEN
    RAISE EXCEPTION '00680: _moto_deportiva_send_notice has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = 'b2e59c4ace99a3d5973c4c57f026ff07' THEN
    v_src := pg_get_functiondef('public._moto_deportiva_send_notice(text)'::regprocedure);
    v_new := replace(v_src,
      'IF NOT public._moto_deportiva_is_on() THEN RETURN 0; END IF;',
      'IF NOT public._moto_deportiva_is_on() THEN RETURN 0; END IF;
  IF NOT public._moto_deportiva_card_visible() THEN RETURN 0; END IF;  -- 00680');
    IF v_new = v_src THEN RAISE EXCEPTION '00680: _moto_deportiva_send_notice anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- The panel shows whether the card is visible.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.admin_moto_deportiva_overview()'::regprocedure;
  IF v_md5 NOT IN ('60f286c0e0f5de6ecb8051ca9dbdc253', 'd5200bdd8be7175644ac3fe7c1f3fd97') THEN
    RAISE EXCEPTION '00680: admin_moto_deportiva_overview has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '60f286c0e0f5de6ecb8051ca9dbdc253' THEN
    v_src := pg_get_functiondef('public.admin_moto_deportiva_overview()'::regprocedure);
    v_new := replace(v_src,
      '''active'', public._moto_deportiva_is_on(),',
      '''active'', public._moto_deportiva_is_on(),
    ''visible'', public._moto_deportiva_card_visible(),  -- 00680');
    IF v_new = v_src THEN RAISE EXCEPTION '00680: admin_moto_deportiva_overview anchor not found'; END IF;
    EXECUTE v_new;
  END IF;
END
$patch$;

-- ── Panel switch ─────────────────────────────────────────────
-- Super admins only. The change is audited by tg_platform_config_audit (00603), like any
-- platform_config edit made with a user's JWT. Showing the card again while a pilot is
-- available tells the subscribers now (the 3 h cooldown of 00679 applies).
CREATE OR REPLACE FUNCTION public.admin_set_moto_deportiva_visible(p_visible boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_sent integer := 0;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  IF p_visible IS NULL THEN RETURN jsonb_build_object('error', 'invalid'); END IF;
  IF public._moto_deportiva_card_visible() = p_visible THEN
    RETURN jsonb_build_object('success', true, 'visible', p_visible, 'notified', 0);
  END IF;
  INSERT INTO public.platform_config (key, value) VALUES ('moto_deportiva_card_visible', to_jsonb(p_visible))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  IF p_visible AND public._moto_deportiva_raw_status() = 'available' THEN
    BEGIN
      v_sent := public._moto_deportiva_send_notice('admin_on');
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.log_rpc_attempt('moto_deportiva_waitlist_push', auth.uid(), NULL::uuid, 'push_failed',
        jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
    END;
  END IF;
  RETURN jsonb_build_object('success', true, 'visible', p_visible, 'notified', v_sent);
END
$function$;
REVOKE ALL ON FUNCTION public.admin_set_moto_deportiva_visible(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_moto_deportiva_visible(boolean) TO authenticated, service_role;

-- ── Pasted from Windows (CRLF) ───────────────────────────────
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._moto_deportiva_card_visible()', 'public.get_moto_deportiva_status()',
    'public._moto_deportiva_send_notice(text)', 'public.admin_moto_deportiva_overview()',
    'public.admin_set_moto_deportiva_visible(boolean)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Self-checks ──────────────────────────────────────────────
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public._moto_deportiva_card_visible()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_set_moto_deportiva_visible(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '00680: grants are wrong';
  END IF;
  IF position('_moto_deportiva_card_visible' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public._moto_deportiva_send_notice(text)'::regprocedure)) = 0
     OR position('_moto_deportiva_card_visible' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public.admin_moto_deportiva_overview()'::regprocedure)) = 0
     OR position('_moto_deportiva_card_visible' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public.get_moto_deportiva_status()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00680: the card switch is not wired';
  END IF;
END
$check$;
