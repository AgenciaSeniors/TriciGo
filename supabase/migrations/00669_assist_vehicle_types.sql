-- ============================================================
-- 00669 — Support's assist page and vehicle types
-- ============================================================
--
-- A. A Confort ride only lists and only takes Confort cars.
--    _vehicle_types_for_service (00628) mapped every 'auto%' service to auto + confort, so for an
--    auto_confort ride admin_ride_assist_candidates listed regular cars, and
--    admin_offer_ride_to_driver / admin_assign_ride_to_driver accepted them through
--    _driver_can_serve_ride. Dispatch sends Confort only to Confort since 00650
--    (find_best_drivers). auto_standard keeps auto + confort, as dispatch does.
--    _apply_ride_service_change uses the same helper to decide which offers to reopen when support
--    changes a ride's type: after this, a ride changed to auto_confort reopens only the offers of
--    Confort cars.
--
-- B. admin_active_ride_context returns driver.vehicle_type, the type of the same vehicle as
--    driver.vehicle_label. Both now read the newest active vehicle (ORDER BY created_at DESC), as
--    admin_ride_assist_candidates does; before, the label took whichever active row came first.
--
-- Both bodies are checked against their md5 before they are replaced: a body this migration does
-- not know stops it, so a newer definition is never overwritten.

-- ── A. _vehicle_types_for_service ───────────────────────────
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public._vehicle_types_for_service(text)'::regprocedure;
  -- 974eac2b…: the body from 00628. 5299ab64…: this migration's (re-applied).
  IF v_md5 NOT IN ('974eac2b16267fca5e5cd78840f0b639', '5299ab645064c495257109e7e53c6e4e') THEN
    RAISE EXCEPTION '00669: _vehicle_types_for_service has an unknown body (md5 %)', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._vehicle_types_for_service(p_service_type text)
 RETURNS vehicle_type[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::public.vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::public.vehicle_type]
    -- Confort only to Confort, as find_best_drivers does since 00650.
    WHEN p_service_type = 'auto_confort' THEN ARRAY['confort'::public.vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::public.vehicle_type, 'confort'::public.vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::public.vehicle_type]
  END
$function$;

-- ── B. admin_active_ride_context: driver.vehicle_type ───────
DO $patch$
DECLARE
  v_md5 text;
  v_def text;
  c_old CONSTANT text := 'FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active LIMIT 1))';
  c_new CONSTANT text := 'FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active ORDER BY v.created_at DESC LIMIT 1),'
    || chr(10) || '        ''vehicle_type'', (SELECT v.type FROM public.vehicles v'
    || chr(10) || '           WHERE v.driver_id = dp.id AND v.is_active ORDER BY v.created_at DESC LIMIT 1))';
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.admin_active_ride_context(uuid)'::regprocedure;
  IF v_md5 = '62031d5be71f09241122be3e64bb3957' THEN
    RETURN;  -- already patched
  END IF;
  -- 76344d25…: the body from 00668.
  IF v_md5 <> '76344d251a2f75b1d4c9f4f059131668' THEN
    RAISE EXCEPTION '00669: admin_active_ride_context has an unknown body (md5 %)', v_md5;
  END IF;
  SELECT pg_get_functiondef('public.admin_active_ride_context(uuid)'::regprocedure) INTO v_def;
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION '00669: admin_active_ride_context does not have the vehicle subquery exactly once';
  END IF;
  EXECUTE replace(v_def, c_old, c_new);
END
$patch$;

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public._vehicle_types_for_service(text)'::regprocedure,
                              'public.admin_active_ride_context(uuid)'::regprocedure] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Checks ──────────────────────────────────────────────────
DO $check$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public._vehicle_types_for_service(text)'::regprocedure;
  IF v_md5 <> '5299ab645064c495257109e7e53c6e4e' THEN
    RAISE EXCEPTION '00669 check: _vehicle_types_for_service md5 is %', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.admin_active_ride_context(uuid)'::regprocedure;
  IF v_md5 <> '62031d5be71f09241122be3e64bb3957' THEN
    RAISE EXCEPTION '00669 check: admin_active_ride_context md5 is %', v_md5;
  END IF;

  IF public._vehicle_types_for_service('auto_confort') IS DISTINCT FROM ARRAY['confort'::public.vehicle_type]
     OR public._vehicle_types_for_service('auto_standard') IS DISTINCT FROM ARRAY['auto'::public.vehicle_type, 'confort'::public.vehicle_type]
     OR public._vehicle_types_for_service('triciclo_basico') IS DISTINCT FROM ARRAY['triciclo'::public.vehicle_type]
     OR public._vehicle_types_for_service('moto_standard') IS DISTINCT FROM ARRAY['moto'::public.vehicle_type]
     OR public._vehicle_types_for_service('mensajeria') IS NOT NULL THEN
    RAISE EXCEPTION '00669 check: _vehicle_types_for_service maps a service to the wrong types';
  END IF;

  -- Permissions do not change with CREATE OR REPLACE: the helper stays out of the clients' reach,
  -- and ops staff keep calling the context through authenticated.
  IF has_function_privilege('anon', 'public._vehicle_types_for_service(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._vehicle_types_for_service(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_active_ride_context(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_active_ride_context(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00669 check: permissions changed';
  END IF;
END
$check$;
