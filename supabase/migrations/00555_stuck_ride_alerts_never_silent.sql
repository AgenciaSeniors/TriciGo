-- ============================================================================
-- 00555 — Que ninguna alerta de viaje trabado desaparezca sin avisar
-- ============================================================================
--
-- Revisión de la tanda de desincronización de conductores (#898-#928). Tres
-- fallas encadenadas dejaban alertas mudas, y una cuarta "mejora" evidente
-- resultó dañina y se documenta abajo para que nadie la implemente.
--
-- ── 1. El correo de 00538 era invisible al watchdog de crons ────────────────
-- check_stuck_active_rides manda su alerta con net.http_post CRUDO, violando
-- la regla que 00529 había fijado dos días antes: todo cron que llame a una
-- Edge Function DEBE usar public.cron_http_post. Sin eso, si send-email falla
-- el cron sigue verde en cron.job_run_details y la alerta se pierde en
-- silencio — exactamente el modo de falla que 00529 existe para eliminar.
-- (00542 sí lo hace bien para su push al pasajero.)
--
-- ── 2. Las alertas 'dead_driver_app' se auto-resolvían sin avisar ───────────
-- Tres piezas, encadenadas:
--   a) 00542 inserta la fila y NO manda ningún correo. Su único envío es el
--      push a los pasajeros liberados, que es otra cosa.
--   b) stuck_ride_alerts tiene PK ride_id y el barrido de 00538 salta todo
--      viaje que ya tenga fila (NOT EXISTS, sin calificar por resolved_at).
--      Así que la fila muda de 00542 se come el correo que 00538 sí habría
--      mandado por ese mismo viaje.
--   c) El paso 1 de 00538 resuelve todo lo que no esté en
--      ('in_progress','arrived_at_destination'), pero 00542 alerta TAMBIÉN
--      sobre 'arrived_at_pickup'. Esas filas se retiran en el siguiente tic de
--      5 min con emailed_at NULL, y como el banner del admin filtra por
--      resolved_at IS NULL, nunca llegan a verse. Nadie se entera jamás.
--
-- ── LO QUE DELIBERADAMENTE NO SE HACE ──────────────────────────────────────
-- Parecía obvio ampliar el `UPDATE ride_offers SET status='expired' ... AND
-- status='pending'` de 00542 (hoy un no-op: para entonces la oferta está en
-- 'accepted') para que el re-armado de 00524 —que exige 'expired'— pudiera
-- volver a ofrecerle el viaje a su propio conductor si revivía.
--
-- NO SE HAGA. ride_offers tiene el trigger ride_offers_refresh_acceptance,
-- AFTER UPDATE OF status FOR EACH ROW, que recalcula
--   driver_profiles.acceptance_rate = accepted / total
-- Mover esa oferta de 'accepted' a 'expired' le baja la tasa de aceptación al
-- conductor, de forma permanente, por haberse quedado sin app. Y
-- find_best_drivers USA acceptance_rate, así que el castigo se compone en
-- menos ofertas futuras. Con el volumen real de hoy (22 ofertas aceptadas en
-- toda la flota, 27 conductores) restarle una a alguien puede partirle la tasa
-- a la mitad. El beneficio —recuperar UN viaje, y solo si revive a tiempo— no
-- lo compensa.
--
-- ── Método ─────────────────────────────────────────────────────────────────
-- Los tres parches son EN SITIO desde el cuerpo VIVO (pg_get_functiondef), no
-- desde la migración en git: no pueden perder features, son idempotentes, y
-- fallan ruidosamente (RAISE EXCEPTION, nunca NOTICE) si el fragmento
-- esperado no aparece. Anclajes verificados en prod: cada uno aparece
-- exactamente 1 vez.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────
-- 1. El emisor de las alertas de conductor muerto
-- ─────────────────────────────────────────────────────────────
-- Busca el pendiente en vez de recibir ids: así también recupera el atraso de
-- filas que 00542 dejó sin avisar desde que se aplicó. Manda UN correo con la
-- lista, no uno por viaje.
CREATE OR REPLACE FUNCTION public.notify_dead_driver_alert()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $fn$
DECLARE
  v_now         timestamptz := now();
  v_ids         uuid[];
  v_rows        text := '';
  v_html        text;
  v_subject     text;
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_sent        integer := 0;
  v_a           record;
BEGIN
  SELECT array_agg(sa.ride_id) INTO v_ids
  FROM stuck_ride_alerts sa
  WHERE sa.reason = 'dead_driver_app'
    AND sa.emailed_at IS NULL
    AND sa.resolved_at IS NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pending', 0, 'emails_sent', 0);
  END IF;

  SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'stuck_ride_alert_email';
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
  END IF;

  -- Sin destinatario NO se estampa emailed_at: la fila queda pendiente y el
  -- próximo tic reintenta, en vez de marcarse como avisada sin haberlo sido.
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    RAISE WARNING '[notify_dead_driver_alert] sin destinatario configurado; % alertas quedan pendientes',
      array_length(v_ids, 1);
    RETURN jsonb_build_object('ok', false, 'pending', array_length(v_ids, 1),
                              'emails_sent', 0, 'error', 'no_recipient');
  END IF;

  FOR v_a IN
    SELECT sa.ride_id, sa.details, sa.detected_at,
           rd.status AS ride_status, rd.pickup_address, rd.dropoff_address,
           cu.full_name AS customer_name,
           du.full_name AS driver_name, du.phone AS driver_phone
    FROM stuck_ride_alerts sa
    JOIN rides rd ON rd.id = sa.ride_id
    LEFT JOIN users cu ON cu.id = rd.customer_id
    LEFT JOIN driver_profiles dp ON dp.id = rd.driver_id
    LEFT JOIN users du ON du.id = dp.user_id
    WHERE sa.ride_id = ANY(v_ids)
    ORDER BY sa.detected_at
  LOOP
    v_rows := v_rows
      || '<tr><td style="padding:8px;border-bottom:1px solid #eee">'
      || '<a href="https://admin.tricigo.com/rides/' || v_a.ride_id::text || '">#'
      || left(v_a.ride_id::text, 8) || '</a><br>'
      -- ::text obligatorio: rides.status es el enum ride_status, y
      -- COALESCE(<enum>, '—') intenta coercionar el guion AL enum → 22P02
      -- "invalid input value for enum ride_status". Lo cazó el ensayo rolleado;
      -- el CREATE pasaba en verde y el EXCEPTION WHEN OTHERS de abajo lo habría
      -- tragado en silencio, dejando la alerta muda para siempre — justo la
      -- clase de falla que esta migración existe para eliminar.
      || '<span style="color:#777;font-size:12px">' || COALESCE(v_a.ride_status::text, '—') || '</span></td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee">'
      || COALESCE(v_a.driver_name, '—') || ' ' || COALESCE(v_a.driver_phone, '')
      || '<br><span style="color:#777;font-size:12px">sin latido hace '
      || COALESCE(v_a.details ->> 'minutes_silent', '?') || ' min</span></td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee">'
      || COALESCE(v_a.customer_name, '—') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">'
      || COALESCE(v_a.pickup_address, '—') || ' → ' || COALESCE(v_a.dropoff_address, '—')
      || '</td></tr>';
  END LOOP;

  v_subject := '[TriciGo] Conductor sin conexión — ' || array_length(v_ids, 1)::text
    || CASE WHEN array_length(v_ids, 1) = 1 THEN ' viaje en curso' ELSE ' viajes en curso' END;

  v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">La app del conductor dejó de responder</h2>'
    || '<p>Estos viajes ya pasaron la recogida, así que <b>el pasajero puede ir a bordo y el viaje puede estar ocurriendo de verdad</b>. '
    || 'Por eso no se cancelan ni se reasignan solos: hace falta revisión humana. '
    || 'Los viajes anteriores a la recogida sí se liberaron automáticamente y ya se está buscando otro conductor.</p>'
    || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
    || '<tr style="text-align:left;background:#f5f5f5">'
    || '<th style="padding:8px">Viaje</th><th style="padding:8px">Conductor</th>'
    || '<th style="padding:8px">Pasajero</th><th style="padding:8px">Ruta</th></tr>'
    || v_rows
    || '</table>'
    || '<p style="color:#777;font-size:12px">Watchdog de conductores muertos (00542 + 00555). '
    || 'Se avisa una sola vez por viaje. No responder.</p>'
    || '</body></html>';

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);

  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
    WHERE position('@' IN x) > 0
  LOOP
    PERFORM public.cron_http_post('dead-driver-alert',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object(
                   'recipient_email', v_rcpt,
                   'subject', v_subject,
                   -- HTML crudo: legacy path de resolveTemplate() (patrón 00503).
                   'template', v_html,
                   'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;

  UPDATE stuck_ride_alerts SET emailed_at = v_now WHERE ride_id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'pending', array_length(v_ids, 1), 'emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  -- Nunca tumbar al cron que la llama: la liberación de viajes es lo crítico,
  -- el correo es el extra.
  RAISE WARNING '[notify_dead_driver_alert] failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$fn$;

REVOKE ALL ON FUNCTION public.notify_dead_driver_alert() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.notify_dead_driver_alert() IS
  '00555: manda por correo las alertas dead_driver_app que 00542 dejaba mudas. '
  'Busca las pendientes (emailed_at IS NULL) en vez de recibir ids, así recupera el atraso. '
  'Sin destinatario configurado NO estampa emailed_at, para que el próximo tic reintente.';


-- ─────────────────────────────────────────────────────────────
-- 2. release_rides_from_dead_drivers la llama tras marcar
-- ─────────────────────────────────────────────────────────────
-- Inserción, no sustitución: el parche añade una línea después del contador y
-- no puede perder nada del cuerpo vivo.
--
-- OJO con la guarda de idempotencia: esta función YA tiene un cron_http_post
-- (el push al pasajero liberado), así que el marcador de 00529 daría un falso
-- positivo y saltaría el parche. Se ancla en el nombre de la función nueva.
DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.release_rides_from_dead_drivers()'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE '00555: release_rides_from_dead_drivers absent; skipping';
    RETURN;
  END IF;
  IF position('notify_dead_driver_alert' IN v_src) > 0 THEN
    RAISE NOTICE '00555: release_rides_from_dead_drivers already notifies; skipping';
    RETURN;
  END IF;
  IF position('GET DIAGNOSTICS v_flagged = ROW_COUNT;' IN v_src) = 0 THEN
    RAISE EXCEPTION '00555: expected fragment not found in release_rides_from_dead_drivers — refusing to patch blindly';
  END IF;
  EXECUTE replace(v_src,
    'GET DIAGNOSTICS v_flagged = ROW_COUNT;',
    'GET DIAGNOSTICS v_flagged = ROW_COUNT;'
    || E'\n\n  -- 00555: avisar por correo. Hasta acá la fila se insertaba muda y 00538'
    || E'\n  -- la auto-resolvía a los 5 min, así que nadie se enteraba nunca.'
    || E'\n  PERFORM public.notify_dead_driver_alert();');
  RAISE NOTICE '00555: release_rides_from_dead_drivers now emails its alerts';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00555: release_rides_from_dead_drivers absent; skipping';
END $patch$;


-- ─────────────────────────────────────────────────────────────
-- 3. El correo de 00538, bajo el watchdog de crons
-- ─────────────────────────────────────────────────────────────
-- No hace falta fila en cron_http_expectations: send-email responde 2xx en el
-- caso normal y check_cron_http_failures() usa
-- COALESCE(e.ok_statuses, ARRAY[200,201,202,204]) por defecto.
DO $patch$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef('public.check_stuck_active_rides()'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE '00555: check_stuck_active_rides absent; skipping';
    RETURN;
  END IF;
  IF position('cron_http_post' IN v_src) > 0 THEN
    RAISE NOTICE '00555: check_stuck_active_rides already covered; skipping';
    RETURN;
  END IF;
  IF position('PERFORM net.http_post(' IN v_src) = 0 THEN
    RAISE EXCEPTION '00555: expected fragment not found in check_stuck_active_rides — refusing to patch blindly';
  END IF;
  EXECUTE replace(v_src,
    'PERFORM net.http_post(',
    'PERFORM public.cron_http_post(''stuck-ride-alert'', ');
  RAISE NOTICE '00555: check_stuck_active_rides now under watchdog coverage';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00555: check_stuck_active_rides absent; skipping';
END $patch$;


-- ─────────────────────────────────────────────────────────────
-- 4. Dejar de retirar alertas de conductor muerto todavía vigentes
-- ─────────────────────────────────────────────────────────────
-- El auto-resolve de 00538 resuelve todo lo que sale de SU set de barrido
-- ('in_progress','arrived_at_destination'). Pero 00542 alerta también sobre
-- 'arrived_at_pickup', que nunca estuvo en ese set — así que sus filas se
-- retiraban en el tic siguiente con el viaje igual de trabado.
DO $patch$
DECLARE
  v_src    text;
  v_target text := 'AND rr.status NOT IN (''in_progress'', ''arrived_at_destination'');';
BEGIN
  SELECT pg_get_functiondef('public.check_stuck_active_rides()'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE '00555: check_stuck_active_rides absent; skipping';
    RETURN;
  END IF;
  IF position('dead_driver_app' IN v_src) > 0 THEN
    RAISE NOTICE '00555: check_stuck_active_rides already keeps dead_driver_app alerts; skipping';
    RETURN;
  END IF;
  IF position(v_target IN v_src) = 0 THEN
    RAISE EXCEPTION '00555: auto-resolve predicate not found in check_stuck_active_rides — refusing to patch blindly';
  END IF;
  EXECUTE replace(v_src, v_target,
    'AND rr.status NOT IN (''in_progress'', ''arrived_at_destination'')'
    || E'\n    -- 00555: 00542 alerta sobre arrived_at_pickup, un estado que este'
    || E'\n    -- barrido no cubre; sin esto la alerta se retiraba sin avisar.'
    || E'\n    AND NOT (sa.reason = ''dead_driver_app'' AND rr.status = ''arrived_at_pickup'');');
  RAISE NOTICE '00555: check_stuck_active_rides keeps dead_driver_app alerts while still stuck';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00555: check_stuck_active_rides absent; skipping';
END $patch$;
