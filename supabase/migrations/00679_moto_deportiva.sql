-- 00679_moto_deportiva.sql
-- Moto Deportiva: a ride type requestable while a listed pilot is online and free.
-- Spec: docs/superpowers/specs/2026-11-08-moto-deportiva-design.md
--
-- A. Service row (is_active = the panel's Activar/Desactivar, activated) and bands: moto_standard rates with the
--    minimum fare 200 CUP lower. The app prices the trip as the moto estimate + the offset (B);
--    these rows feed only the server floor (tg_rides_validate_estimated_fare) and ceiling (00631).
-- B. Settings: price offset, visibility, notice cooldown.
-- C. Lock tables moto_deportiva_pilots and moto_deportiva_waitlist.
-- D. Helpers _moto_deportiva_is_on() and _md_driver_allowed(driver_profile_id, service_type).
-- E. md5-guarded in-place patches of find_best_drivers, notify_offline_drivers_for_searching_rides
--    and _driver_can_serve_ride.
-- F. get_moto_deportiva_status() for the apps.
-- G. BEFORE INSERT guard on rides.
-- H. _moto_deportiva_send_notice(): one notice to every subscriber, once per cooldown, logged in
--    moto_deportiva_notices. Called when a pilot goes online (trigger on driver_profiles.is_online)
--    and when a super admin activates the service while a pilot is online.
-- I. RPCs: waitlist (users); overview, activate/deactivate, pilots, subscribers, metrics (super admins).

-- ── A. Service and bands ─────────────────────────────────────
INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   max_passengers, icon_name, is_active, per_wait_minute_rate_cup, free_wait_minutes,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd, per_wait_minute_rate_usd)
SELECT 'moto_deportiva', 'Moto Deportiva', 'Sport Motorbike',
       s.base_fare_cup, s.per_km_rate_cup, s.per_minute_rate_cup, GREATEST(s.min_fare_cup - 200, 0),
       1, s.icon_name, true, s.per_wait_minute_rate_cup, s.free_wait_minutes,
       s.base_fare_usd, s.per_km_rate_usd, s.per_minute_rate_usd,
       CASE WHEN s.min_fare_cup > 0
            THEN s.min_fare_usd * GREATEST(s.min_fare_cup - 200, 0) / s.min_fare_cup END,
       s.per_wait_minute_rate_usd
  FROM public.service_type_configs s
 WHERE s.slug = 'moto_standard'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.pricing_rules
  (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup,
   time_window_start, time_window_end, day_of_week, is_active, city_id,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd,
   per_wait_minute_rate_cup, per_wait_minute_rate_usd)
SELECT p.zone_id, 'moto_deportiva', p.base_fare_cup, p.per_km_rate_cup, p.per_minute_rate_cup,
       GREATEST(p.min_fare_cup - 200, 0),
       p.time_window_start, p.time_window_end, p.day_of_week, p.is_active, p.city_id,
       p.base_fare_usd, p.per_km_rate_usd, p.per_minute_rate_usd,
       CASE WHEN p.min_fare_cup > 0
            THEN p.min_fare_usd * GREATEST(p.min_fare_cup - 200, 0) / p.min_fare_cup END,
       p.per_wait_minute_rate_cup, p.per_wait_minute_rate_usd
  FROM public.pricing_rules p
 WHERE p.service_type = 'moto_standard' AND p.is_active
   AND NOT EXISTS (SELECT 1 FROM public.pricing_rules q WHERE q.service_type = 'moto_deportiva');

SELECT public.recompute_cup_from_usd_prices();

-- ── B. Settings ──────────────────────────────────────────────
INSERT INTO public.platform_config (key, value) VALUES
  ('moto_deportiva_price_offset_cup', '-200'::jsonb),
  ('moto_deportiva_show_when_unavailable', 'true'::jsonb),
  ('moto_deportiva_waitlist_cooldown_h', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── C. Lock tables ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.moto_deportiva_pilots (
  driver_profile_id uuid PRIMARY KEY REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.moto_deportiva_pilots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moto_deportiva_pilots FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moto_deportiva_pilots TO service_role;

CREATE TABLE IF NOT EXISTS public.moto_deportiva_waitlist (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
ALTER TABLE public.moto_deportiva_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moto_deportiva_waitlist FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moto_deportiva_waitlist TO service_role;

-- One row per notice sent (cooldown and metrics: cron_http_calls keeps only 24 h).
CREATE TABLE IF NOT EXISTS public.moto_deportiva_notices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now(),
  recipients integer NOT NULL,
  source text NOT NULL CHECK (source IN ('pilot_online', 'admin_on'))
);
ALTER TABLE public.moto_deportiva_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moto_deportiva_notices FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moto_deportiva_notices TO service_role;

-- ── D. Helpers ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._moto_deportiva_is_on()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE((SELECT is_active FROM public.service_type_configs WHERE slug = 'moto_deportiva'), false)
$function$;

-- moto_deportiva: only pilots. Any other service: everybody except pilots.
CREATE OR REPLACE FUNCTION public._md_driver_allowed(p_driver_profile_id uuid, p_service_type text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_service_type = 'moto_deportiva' THEN
      EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id)
    ELSE NOT EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id)
  END
$function$;
REVOKE ALL ON FUNCTION public._moto_deportiva_is_on() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._md_driver_allowed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._moto_deportiva_is_on() TO service_role;
GRANT EXECUTE ON FUNCTION public._md_driver_allowed(uuid, text) TO service_role;

-- ── E. Dispatch patches (live body, md5-guarded, idempotent) ─
DO $patch$
DECLARE
  v_md5 text; v_src text; v_new text;
  c_fbd regprocedure := 'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure;
BEGIN
  -- E1. find_best_drivers
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fbd;
  IF v_md5 NOT IN ('ec914394abd6f03eeedffc1ae51e8db0', '401af5186bc34c13559d75a0f7e19cfe') THEN
    RAISE EXCEPTION '00679: find_best_drivers has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = 'ec914394abd6f03eeedffc1ae51e8db0' THEN
    v_src := pg_get_functiondef(c_fbd);
    v_new := replace(v_src,
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))',
      'AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND public._md_driver_allowed(dp.id, p_service_type)  -- 00679');
    IF v_new = v_src THEN RAISE EXCEPTION '00679: find_best_drivers anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- E2. notify_offline_drivers_for_searching_rides
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.notify_offline_drivers_for_searching_rides()'::regprocedure;
  IF v_md5 NOT IN ('2a317ff22745d2bbf80c86b20b426a17', '38ca2bf6cdb427882fcfabe1b00a8b9d') THEN
    RAISE EXCEPTION '00679: notify_offline_drivers_for_searching_rides has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '2a317ff22745d2bbf80c86b20b426a17' THEN
    v_src := pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure);
    -- Own group label; no vehicle branch matches it, so nobody is pushed for it.
    v_new := replace(v_src,
      'WHEN r.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
        WHEN r.service_type LIKE ''moto%''     THEN ''moto''');
    v_new := replace(v_new,
      'WHEN r2.service_type LIKE ''moto%''     THEN ''moto''',
      'WHEN r2.service_type = ''moto_deportiva'' THEN ''moto_deportiva''
                 WHEN r2.service_type LIKE ''moto%''     THEN ''moto''');
    -- Pilots are never woken up for other services.
    v_new := replace(v_new,
      'AND dp.is_online = false',
      'AND dp.is_online = false
      AND public._md_driver_allowed(dp.id, v_group.label)  -- 00679');
    IF (length(v_new) - length(replace(v_new, '-- 00679', ''))) / length('-- 00679') <> 1
       OR (length(v_new) - length(replace(v_new, '''moto_deportiva'' THEN', ''))) / length('''moto_deportiva'' THEN') <> 2 THEN
      RAISE EXCEPTION '00679: notify_offline anchors not found exactly once';
    END IF;
    EXECUTE v_new;
  END IF;

  -- E3. _driver_can_serve_ride (support offers and assignments)
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure;
  IF v_md5 NOT IN ('733f31677b6c4c146efa6434976180a8', '770b020e687a712eb87d29237bcf0b4f') THEN
    RAISE EXCEPTION '00679: _driver_can_serve_ride has an unknown body (md5 %)', v_md5;
  END IF;
  IF v_md5 = '733f31677b6c4c146efa6434976180a8' THEN
    v_src := pg_get_functiondef('public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure);
    v_new := replace(v_src,
      'AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)',
      'AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)
      AND public._md_driver_allowed(p_driver_id, p_service_type)  -- 00679');
    IF v_new = v_src THEN RAISE EXCEPTION '00679: _driver_can_serve_ride anchor not found'; END IF;
    EXECUTE v_new;
  END IF;
END
$patch$;

-- ── F. Status for the apps ───────────────────────────────────
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

  IF NOT public._moto_deportiva_is_on() THEN
    v_status := 'off';
  ELSIF EXISTS (
    SELECT 1 FROM public.moto_deportiva_pilots mp
    JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
    WHERE dp.is_online AND dp.status = 'approved' AND NOT dp.is_on_break
      AND NOT EXISTS (SELECT 1 FROM public.rides r WHERE r.driver_id = dp.id
                       AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination'))
  ) AND NOT EXISTS (
    -- Someone already asked for it in the last 150 s: the pilot is about to be busy.
    SELECT 1 FROM public.rides r WHERE r.service_type = 'moto_deportiva' AND r.status = 'searching'
      AND r.created_at > now() - interval '150 seconds'
  ) THEN
    v_status := 'available';
  ELSIF EXISTS (
    SELECT 1 FROM public.moto_deportiva_pilots mp
    JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
    WHERE dp.is_online AND dp.status = 'approved'
  ) THEN
    v_status := 'busy';
  ELSE
    v_status := 'offline';
  END IF;

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

-- ── G. Insert guard ──────────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user tells a client write from a server one.
CREATE OR REPLACE FUNCTION public.tg_rides_moto_deportiva_guard()
 RETURNS trigger LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.service_type <> 'moto_deportiva' OR current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.ride_mode, 'passenger') <> 'passenger'
     OR NEW.corporate_account_id IS NOT NULL
     OR (NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now())
     OR (public.get_moto_deportiva_status() ->> 'status') <> 'available' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'La Moto Deportiva no está disponible en este momento.',
      DETAIL  = 'moto_deportiva_unavailable';
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS rides_moto_deportiva_guard ON public.rides;
CREATE TRIGGER rides_moto_deportiva_guard BEFORE INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_moto_deportiva_guard();

-- ── H. Notice to subscribers ─────────────────────────────────
-- Permanent subscriptions: everybody on the list, every time, at most once per cooldown.
-- Batches of 300 ids: send-push filters with .in() (CLAUDE.md, campaigns).
-- Returns the number of people notified (0 when skipped). Callers swallow its errors.
CREATE OR REPLACE FUNCTION public._moto_deportiva_send_notice(p_source text)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_key text;
  v_ids uuid[];
  v_batch uuid[];
  v_cooldown_h int;
  i int;
BEGIN
  IF NOT public._moto_deportiva_is_on() THEN RETURN 0; END IF;
  -- Two pilots connecting at once, or a pilot and a super admin, must not both send.
  PERFORM pg_advisory_xact_lock(hashtext('moto_deportiva_waitlist_notice'));
  v_cooldown_h := GREATEST(0, public.get_platform_config_numeric('moto_deportiva_waitlist_cooldown_h', 3))::int;
  IF EXISTS (SELECT 1 FROM public.moto_deportiva_notices
              WHERE sent_at > now() - make_interval(hours => v_cooldown_h)) THEN
    RETURN 0;
  END IF;
  SELECT array_agg(user_id) INTO v_ids FROM public.moto_deportiva_waitlist;
  IF v_ids IS NULL THEN RETURN 0; END IF;
  v_key := public.get_service_role_key();
  IF COALESCE(v_key, '') = '' THEN RAISE EXCEPTION 'moto_deportiva_no_service_key'; END IF;
  FOR i IN 1 .. array_length(v_ids, 1) BY 300 LOOP
    v_batch := v_ids[i : i + 299];
    PERFORM public.cron_http_post('moto-deportiva-waitlist',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                   'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      body    := jsonb_build_object(
        'user_ids', to_jsonb(v_batch),
        'title',    '¡La Moto Deportiva está disponible!',
        'body',     'Pídela ahora en TriciGo.',
        'category', 'promo',
        'data',     jsonb_build_object('content_type', 'moto_deportiva')),
      timeout_milliseconds := 30000);
  END LOOP;
  UPDATE public.moto_deportiva_waitlist SET notified_at = now() WHERE user_id = ANY (v_ids);
  INSERT INTO public.moto_deportiva_notices (recipients, source) VALUES (array_length(v_ids, 1), p_source);
  RETURN array_length(v_ids, 1);
END
$function$;
REVOKE ALL ON FUNCTION public._moto_deportiva_send_notice(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._moto_deportiva_send_notice(text) TO service_role;

-- A pilot going online. Never blocks the pilot: any failure is logged and swallowed.
CREATE OR REPLACE FUNCTION public.tg_moto_deportiva_pilot_online()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT NEW.is_online OR COALESCE(OLD.is_online, false)
     OR NOT EXISTS (SELECT 1 FROM public.moto_deportiva_pilots WHERE driver_profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public._moto_deportiva_send_notice('pilot_online');
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.log_rpc_attempt('moto_deportiva_waitlist_push', auth.uid(), NEW.id, 'push_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS driver_profiles_moto_deportiva_online ON public.driver_profiles;
CREATE TRIGGER driver_profiles_moto_deportiva_online AFTER UPDATE OF is_online ON public.driver_profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_moto_deportiva_pilot_online();
REVOKE ALL ON FUNCTION public.tg_moto_deportiva_pilot_online() FROM PUBLIC, anon, authenticated;

-- ── I. RPCs ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_moto_deportiva_waitlist(p_join boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('error', 'unauthenticated'); END IF;
  IF p_join THEN
    INSERT INTO public.moto_deportiva_waitlist (user_id) VALUES (auth.uid())
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    DELETE FROM public.moto_deportiva_waitlist WHERE user_id = auth.uid();
  END IF;
  RETURN jsonb_build_object('success', true, 'waiting', p_join);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_overview()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  RETURN jsonb_build_object(
    'active', public._moto_deportiva_is_on(),
    'status', public.get_moto_deportiva_status() ->> 'status',
    'waitlist_count', (SELECT count(*) FROM public.moto_deportiva_waitlist),
    'last_notice_at', (SELECT max(sent_at) FROM public.moto_deportiva_notices),
    'pilots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'driver_profile_id', dp.id, 'full_name', u.full_name,
               'is_online', dp.is_online, 'status', dp.status) ORDER BY u.full_name)
        FROM public.moto_deportiva_pilots mp
        JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
        JOIN public.users u ON u.id = dp.user_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_subscribers()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  RETURN jsonb_build_object('subscribers', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', w.user_id, 'full_name', u.full_name, 'phone', u.phone,
             'subscribed_at', w.created_at, 'notified_at', w.notified_at) ORDER BY w.created_at DESC)
      FROM public.moto_deportiva_waitlist w
      JOIN public.users u ON u.id = w.user_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_moto_deportiva_subscriber(p_user_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  DELETE FROM public.moto_deportiva_waitlist WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_subscribed'); END IF;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_remove_subscriber', 'user', p_user_id::text,
          jsonb_build_object('subscribed', false));
  RETURN jsonb_build_object('success', true);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_moto_deportiva(p_active boolean)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_old boolean; v_sent integer := 0;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  SELECT is_active INTO v_old FROM public.service_type_configs WHERE slug = 'moto_deportiva' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_installed'); END IF;
  IF v_old = p_active THEN RETURN jsonb_build_object('success', true, 'active', p_active); END IF;
  UPDATE public.service_type_configs SET is_active = p_active, updated_at = now() WHERE slug = 'moto_deportiva';
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (auth.uid(), 'moto_deportiva_switch', 'service_type', 'moto_deportiva',
          jsonb_build_object('is_active', v_old), jsonb_build_object('is_active', p_active));
  -- Activated while a pilot is already online: subscribers hear it now, not at his next connection.
  IF p_active AND EXISTS (
    SELECT 1 FROM public.moto_deportiva_pilots mp
    JOIN public.driver_profiles dp ON dp.id = mp.driver_profile_id
    WHERE dp.is_online AND dp.status = 'approved') THEN
    BEGIN
      v_sent := public._moto_deportiva_send_notice('admin_on');
    EXCEPTION WHEN OTHERS THEN
      PERFORM public.log_rpc_attempt('moto_deportiva_waitlist_push', auth.uid(), NULL::uuid, 'push_failed',
        jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
    END;
  END IF;
  RETURN jsonb_build_object('success', true, 'active', p_active, 'notified', v_sent);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_moto_deportiva_pilot(p_phone text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE v_user uuid; v_dp uuid;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  v_user := public._user_id_by_verified_phone(p_phone);
  IF v_user IS NULL THEN RETURN jsonb_build_object('error', 'phone_not_found'); END IF;
  SELECT dp.id INTO v_dp FROM public.driver_profiles dp
   WHERE dp.user_id = v_user AND dp.status = 'approved'
     AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active AND v.type = 'moto');
  IF v_dp IS NULL THEN RETURN jsonb_build_object('error', 'not_an_approved_moto_driver'); END IF;
  INSERT INTO public.moto_deportiva_pilots (driver_profile_id, added_by) VALUES (v_dp, auth.uid())
  ON CONFLICT (driver_profile_id) DO NOTHING;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_add_pilot', 'driver_profile', v_dp::text, jsonb_build_object('pilot', true));
  RETURN jsonb_build_object('success', true, 'driver_profile_id', v_dp);
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_moto_deportiva_pilot(p_driver_profile_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  DELETE FROM public.moto_deportiva_pilots WHERE driver_profile_id = p_driver_profile_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_a_pilot'); END IF;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, new_values)
  VALUES (auth.uid(), 'moto_deportiva_remove_pilot', 'driver_profile', p_driver_profile_id::text,
          jsonb_build_object('pilot', false));
  RETURN jsonb_build_object('success', true);
END
$function$;

-- Numbers for marketing over the last p_days (1..90). Heartbeats are kept 30 days
-- (driver_heartbeat_retention_days), so pilot hours never cover more than that.
CREATE OR REPLACE FUNCTION public.admin_moto_deportiva_metrics(p_days integer DEFAULT 30)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_days int := LEAST(GREATEST(COALESCE(p_days, 30), 1), 90);
  v_from timestamptz;
BEGIN
  IF NOT public.is_super_admin() THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
  v_from := now() - make_interval(days => v_days);
  RETURN jsonb_build_object(
    'days', v_days,
    'subscribers_now', (SELECT count(*) FROM public.moto_deportiva_waitlist),
    'subscribers_new', (SELECT count(*) FROM public.moto_deportiva_waitlist WHERE created_at >= v_from),
    'notices_sent', (SELECT count(*) FROM public.moto_deportiva_notices WHERE sent_at >= v_from),
    'people_notified', (SELECT COALESCE(sum(recipients), 0) FROM public.moto_deportiva_notices WHERE sent_at >= v_from),
    'requests', (SELECT count(*) FROM public.rides WHERE service_type = 'moto_deportiva' AND created_at >= v_from),
    'completed', (SELECT count(*) FROM public.rides WHERE service_type = 'moto_deportiva' AND status = 'completed' AND created_at >= v_from),
    'canceled', (SELECT count(*) FROM public.rides WHERE service_type = 'moto_deportiva' AND status = 'canceled' AND created_at >= v_from),
    'switched_to_moto', (SELECT count(*) FROM public.rides WHERE service_type = 'moto_deportiva' AND status = 'canceled'
                          AND cancellation_reason = 'moto_deportiva_fallback' AND created_at >= v_from),
    'revenue_cup', (SELECT COALESCE(sum(final_fare_cup), 0) FROM public.rides
                     WHERE service_type = 'moto_deportiva' AND status = 'completed' AND created_at >= v_from),
    'first_ride_people', (
      SELECT count(*) FROM (
        SELECT DISTINCT ON (r.customer_id) r.customer_id, r.service_type, r.completed_at
          FROM public.rides r
         WHERE r.status = 'completed'
         ORDER BY r.customer_id, r.completed_at) f
       WHERE f.service_type = 'moto_deportiva' AND f.completed_at >= v_from),
    'pilot_hours_online', (
      SELECT round(count(DISTINCT (h.driver_profile_id, date_trunc('hour', h.beat_at)
                     + floor(extract(minute FROM h.beat_at) / 5) * interval '5 minutes')) * 5 / 60.0, 1)
        FROM public.driver_heartbeat_log h
        JOIN public.moto_deportiva_pilots mp ON mp.driver_profile_id = h.driver_profile_id
       WHERE h.is_online AND h.beat_at >= v_from));
END
$function$;
REVOKE ALL ON FUNCTION public.admin_moto_deportiva_metrics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_metrics(integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.set_moto_deportiva_waitlist(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_moto_deportiva_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_moto_deportiva_subscribers() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_moto_deportiva_subscriber(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_moto_deportiva(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_moto_deportiva_pilot(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_moto_deportiva_waitlist(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_overview() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_moto_deportiva_subscribers() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_moto_deportiva_subscriber(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_moto_deportiva(boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_add_moto_deportiva_pilot(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_remove_moto_deportiva_pilot(uuid) TO authenticated, service_role;

-- ── Pasted from Windows (CRLF) ───────────────────────────────
-- The new bodies and the text inserted by the patches carry a carriage return: rewrite them
-- without it, so the bodies match git and the md5 guards of E accept a later re-run.
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)',
    'public.notify_offline_drivers_for_searching_rides()', 'public._driver_can_serve_ride(uuid,text,boolean)',
    'public._moto_deportiva_is_on()', 'public._md_driver_allowed(uuid,text)', 'public.get_moto_deportiva_status()',
    'public.tg_rides_moto_deportiva_guard()', 'public._moto_deportiva_send_notice(text)',
    'public.tg_moto_deportiva_pilot_online()', 'public.set_moto_deportiva_waitlist(boolean)',
    'public.admin_moto_deportiva_overview()', 'public.admin_moto_deportiva_subscribers()',
    'public.admin_remove_moto_deportiva_subscriber(uuid)', 'public.admin_set_moto_deportiva(boolean)',
    'public.admin_add_moto_deportiva_pilot(text)', 'public.admin_remove_moto_deportiva_pilot(uuid)',
    'public.admin_moto_deportiva_metrics(integer)']::regprocedure[]
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
  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = 'moto_deportiva') THEN
    RAISE EXCEPTION '00679: service row missing';
  END IF;
  IF (SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_deportiva' AND is_active)
     <> (SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_standard' AND is_active) THEN
    RAISE EXCEPTION '00679: the bands were not copied';
  END IF;
  IF has_table_privilege('anon', 'public.moto_deportiva_waitlist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.moto_deportiva_waitlist', 'SELECT')
     OR has_table_privilege('authenticated', 'public.moto_deportiva_pilots', 'SELECT') THEN
    RAISE EXCEPTION '00679: lock tables are readable by clients';
  END IF;
  IF has_table_privilege('authenticated', 'public.moto_deportiva_notices', 'SELECT') THEN
    RAISE EXCEPTION '00679: moto_deportiva_notices is readable by clients';
  END IF;
  IF has_function_privilege('authenticated', 'public._md_driver_allowed(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00679: _md_driver_allowed is executable by clients';
  END IF;
  IF position('_md_driver_allowed' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure)) = 0
     OR position('_md_driver_allowed' IN (SELECT prosrc FROM pg_proc WHERE oid =
       'public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00679: dispatch not patched';
  END IF;
END
$check$;
