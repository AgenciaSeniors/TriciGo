-- ============================================================
-- 00632 — support alerts name the vehicle the rider asked for
--
-- Support reported on 2026-10-07, with the first real alerts of 00628, that neither the push
-- nor the e-mail says which vehicle the rider asked for. It is the first thing support needs:
-- it decides which drivers to call. The admin panel shows it from the same release.
--
--   * _ride_type_label(service_type, ride_mode): "Triciclo", "Moto", "Envío · Moto". The name
--     comes from service_type_configs.name_es, so a rename in the admin applies here too; an
--     unknown slug shows as itself, never as an empty label.
--   * _support_alert: the push title becomes "Viaje sin conductor · Triciclo · A1737308"
--     (and "Pasajero pide ayuda · Triciclo · …"). The type goes in the title because a phone
--     cuts the body first.
--   * notify_support_waiting_rides: the e-mail digest gets a "Vehículo" column.
--
-- Both functions are patched in place from their live bodies (CLAUDE.md, "Patch in-place"):
-- each patch runs only on the 00628 body (md5 below), is skipped on the body this file
-- leaves, and refuses any other body. Each target appears exactly once in the 00628 body.
--
-- Rehearsal: supabase/tests/00632/run.sh (RED without this file, GREEN with it, applied twice)
-- ============================================================

-- 1. The label. SECURITY INVOKER: only the SECURITY DEFINER alert functions call it, as
--    their owner. No client role may execute it.
CREATE OR REPLACE FUNCTION public._ride_type_label(p_service_type text, p_ride_mode text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN p_ride_mode = 'cargo' THEN 'Envío · ' ELSE '' END
      || COALESCE((SELECT NULLIF(btrim(c.name_es), '') FROM public.service_type_configs c
                    WHERE c.slug = p_service_type),
                  NULLIF(btrim(p_service_type), ''),
                  '—')
$$;
REVOKE ALL ON FUNCTION public._ride_type_label(text, text) FROM PUBLIC, anon, authenticated;

-- 2. The push title.
DO $patch$
DECLARE
  c_fn  constant regprocedure := 'public._support_alert(uuid, text)'::regprocedure;
  c_old constant text := '63c4d28507585e3d92f74dfc84ddbe74';
  c_new constant text := '1ee5af719375723f47a7e17e037c0781';
  c_from constant text := $x632$  v_title := CASE WHEN p_kind = 'help' THEN 'Pasajero pide ayuda · ' ELSE 'Viaje sin conductor · ' END || v_code;$x632$;
  c_to   constant text := $x632$  v_title := CASE WHEN p_kind = 'help' THEN 'Pasajero pide ayuda · ' ELSE 'Viaje sin conductor · ' END
             || public._ride_type_label(v_ride.service_type, v_ride.ride_mode) || ' · ' || v_code;$x632$;
  v_src text;
  v_md5 text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_fn;
  v_md5 := md5(v_src);
  IF v_md5 = c_new THEN
    RAISE NOTICE '00632: _support_alert already names the vehicle';
  ELSIF v_md5 = c_old THEN
    IF (length(v_src) - length(replace(v_src, c_from, ''))) / length(c_from) <> 1 THEN
      RAISE EXCEPTION '00632: the push title is not in _support_alert exactly once';
    END IF;
    EXECUTE replace(pg_get_functiondef(c_fn), c_from, c_to);
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
    IF v_md5 <> c_new THEN
      RAISE EXCEPTION '00632: _support_alert patched to an unexpected body (md5 %)', v_md5;
    END IF;
  ELSE
    RAISE EXCEPTION '00632: _support_alert has a body this file does not know (md5 %); patch it from the live body', v_md5;
  END IF;
END
$patch$;

-- 3. The e-mail digest: a "Vehículo" column, after the code.
DO $patch$
DECLARE
  c_fn  constant regprocedure := 'public.notify_support_waiting_rides()'::regprocedure;
  c_old constant text := '94fbc129807e30c0bdc10cd55ae99b4f';
  c_new constant text := 'c69e1ca717436dad23eada26af46e0ce';
  c_from text[] := ARRAY[
    $x632$        SELECT r.id, r.pickup_address, r.dropoff_address,$x632$,
    $x632$'<tr><td style="%1$s"><b>%2$s</b></td><td style="%1$s">%3$s</td>$x632$,
    $x632$          'https://admin.tricigo.com/rides/' || v_rec.id::text || '/assist');$x632$,
    $x632$<th style="padding:6px">Código</th>$x632$];
  c_to text[] := ARRAY[
    $x632$        SELECT r.id, r.pickup_address, r.dropoff_address,
               public._ride_type_label(r.service_type, r.ride_mode) AS type_label,$x632$,
    $x632$'<tr><td style="%1$s"><b>%2$s</b></td><td style="%1$s">%8$s</td><td style="%1$s">%3$s</td>$x632$,
    $x632$          'https://admin.tricigo.com/rides/' || v_rec.id::text || '/assist',
          public._html_escape(v_rec.type_label));$x632$,
    $x632$<th style="padding:6px">Código</th><th style="padding:6px">Vehículo</th>$x632$];
  v_src text;
  v_def text;
  v_md5 text;
  i integer;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = c_fn;
  v_md5 := md5(v_src);
  IF v_md5 = c_new THEN
    RAISE NOTICE '00632: the support e-mail already names the vehicle';
  ELSIF v_md5 = c_old THEN
    v_def := pg_get_functiondef(c_fn);
    FOR i IN 1 .. cardinality(c_from) LOOP
      IF (length(v_src) - length(replace(v_src, c_from[i], ''))) / length(c_from[i]) <> 1 THEN
        RAISE EXCEPTION '00632: target % is not in notify_support_waiting_rides exactly once', i;
      END IF;
      v_def := replace(v_def, c_from[i], c_to[i]);
    END LOOP;
    EXECUTE v_def;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
    IF v_md5 <> c_new THEN
      RAISE EXCEPTION '00632: notify_support_waiting_rides patched to an unexpected body (md5 %)', v_md5;
    END IF;
  ELSE
    RAISE EXCEPTION '00632: notify_support_waiting_rides has a body this file does not know (md5 %); patch it from the live body', v_md5;
  END IF;
END
$patch$;

-- 4. What this file promises.
DO $check$
BEGIN
  IF has_function_privilege('anon', 'public._ride_type_label(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._ride_type_label(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00632: a client role can execute _ride_type_label';
  END IF;
  IF public._ride_type_label(NULL, NULL) IS NULL OR public._ride_type_label('', 'cargo') IS NULL THEN
    RAISE EXCEPTION '00632: _ride_type_label returned NULL, which would blank the push title';
  END IF;
END
$check$;
