-- Scaffold for the 00646 rehearsal: the tables the two alert functions read, stubs for
-- config, the service key and cron_http_post (it records the e-mail it would send),
-- _html_escape (00628) and the two functions exactly as prod had them on 2026-10-08
-- (pg_get_functiondef; md5 of prosrc checked by run.sh S0).
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.users (id uuid PRIMARY KEY, full_name text, phone text);
CREATE TABLE public.driver_profiles (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY, status text, pickup_address text, dropoff_address text,
  customer_id uuid, driver_id uuid, pickup_at timestamptz, accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.stuck_ride_alerts (
  ride_id uuid PRIMARY KEY, reason text, details jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(), emailed_at timestamptz, resolved_at timestamptz);
CREATE TABLE public.validation_events (ride_id uuid, event_type text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ride_location_events (id bigserial PRIMARY KEY, ride_id uuid, location geography, recorded_at timestamptz);
CREATE TABLE public.ride_messages (ride_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sent_emails (id bigserial PRIMARY KEY, jobname text, body jsonb);

CREATE FUNCTION public.get_platform_config_numeric(p_key text, p_default numeric)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::numeric FROM public.platform_config WHERE key = p_key), p_default)
$$;
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $$ SELECT 'service-key' $$;
CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.sent_emails (jobname, body) VALUES (p_jobname, body) RETURNING id
$$;

CREATE OR REPLACE FUNCTION public._html_escape(p_text text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT replace(replace(replace(replace(replace(coalesce(p_text, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$function$
;

CREATE OR REPLACE FUNCTION public.notify_dead_driver_alert()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
                   'template', v_html,
                   'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;

  UPDATE stuck_ride_alerts SET emailed_at = v_now WHERE ride_id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'pending', array_length(v_ids, 1), 'emails_sent', v_sent);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_stuck_active_rides()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_enabled     text;
  v_win_s       integer;
  v_radius_m    integer;
  v_chat_s      integer;
  v_now         timestamptz := now();
  v_ride        RECORD;
  v_last_loc    geography;
  v_pt_count    integer;
  v_max_dist    numeric;
  v_span_s      numeric;
  v_blocked     boolean;
  v_chat        boolean;
  v_reason      text;
  v_customer    text;
  v_driver_name text;
  v_driver_tel  text;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_alerted     integer := 0;
  v_resolved    integer := 0;
  v_sent        integer := 0;
BEGIN
  -- Trampa jsonb (CLAUDE.md): #>> '{}' normaliza boolean true y string "true"
  -- a 'true', así el kill-switch funciona con ambas formas.
  SELECT value #>> '{}' INTO v_enabled FROM platform_config WHERE key = 'stuck_ride_watchdog_enabled';
  IF COALESCE(v_enabled, 'true') = 'false' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'disabled');
  END IF;

  v_win_s    := COALESCE(get_platform_config_numeric('stuck_ride_stationary_min_s', 300), 300)::int;
  v_radius_m := COALESCE(get_platform_config_numeric('stuck_ride_stationary_radius_m', 60), 60)::int;
  v_chat_s   := COALESCE(get_platform_config_numeric('stuck_ride_chat_window_s', 900), 900)::int;

  -- 1) Resolver en silencio las alertas cuyo viaje ya cerró.
  UPDATE stuck_ride_alerts sa SET resolved_at = v_now
  FROM rides rr
  WHERE rr.id = sa.ride_id
    AND sa.resolved_at IS NULL
    AND rr.status NOT IN ('in_progress', 'arrived_at_destination')
    -- 00555: 00542 alerta sobre arrived_at_pickup, un estado que este
    -- barrido no cubre; sin esto la alerta se retiraba sin avisar.
    AND NOT (sa.reason = 'dead_driver_app' AND rr.status = 'arrived_at_pickup');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  -- 2) Barrer los viajes activos aún no alertados.
  FOR v_ride IN
    SELECT rr.id, rr.status, rr.pickup_address, rr.dropoff_address,
           rr.customer_id, rr.driver_id, rr.pickup_at, rr.accepted_at, rr.created_at
    FROM rides rr
    WHERE rr.status IN ('in_progress', 'arrived_at_destination')
      AND NOT EXISTS (SELECT 1 FROM stuck_ride_alerts sa WHERE sa.ride_id = rr.id)
  LOOP
    -- Señal directa: intentos de finalizar bloqueados por distancia (00537).
    SELECT EXISTS (
      SELECT 1 FROM validation_events ve
      WHERE ve.ride_id = v_ride.id
        AND ve.event_type = 'complete_blocked_distance'
        AND ve.created_at >= COALESCE(v_ride.accepted_at, v_ride.created_at)
    ) INTO v_blocked;

    v_reason := NULL;

    IF v_blocked THEN
      v_reason := 'complete_blocked';
      v_max_dist := NULL;
      v_span_s := NULL;
    ELSE
      -- Señal inferida: conductor quieto + chat reciente.
      SELECT le.location::geography INTO v_last_loc
      FROM ride_location_events le
      WHERE le.ride_id = v_ride.id
      ORDER BY le.recorded_at DESC, le.id DESC
      LIMIT 1;

      IF v_last_loc IS NOT NULL THEN
        SELECT count(*),
               max(ST_Distance(le.location::geography, v_last_loc)),
               extract(epoch FROM (max(le.recorded_at) - min(le.recorded_at)))
          INTO v_pt_count, v_max_dist, v_span_s
        FROM ride_location_events le
        WHERE le.ride_id = v_ride.id
          AND le.recorded_at >= v_now - make_interval(secs => v_win_s);

        IF v_pt_count >= 3
           AND v_span_s >= (v_win_s * 0.8)
           AND v_max_dist <= v_radius_m THEN
          SELECT EXISTS (
            SELECT 1 FROM ride_messages rm
            WHERE rm.ride_id = v_ride.id
              AND rm.created_at >= v_now - make_interval(secs => v_chat_s)
          ) INTO v_chat;
          IF v_chat THEN
            v_reason := 'stationary_chat';
          END IF;
        END IF;
      END IF;
    END IF;

    CONTINUE WHEN v_reason IS NULL;

    INSERT INTO stuck_ride_alerts (ride_id, reason, details)
    VALUES (
      v_ride.id,
      v_reason,
      jsonb_build_object(
        'status_at_detection', v_ride.status,
        'stationary_max_dist_m', v_max_dist,
        'stationary_span_s', v_span_s
      )
    )
    ON CONFLICT (ride_id) DO NOTHING;
    v_alerted := v_alerted + 1;

    -- 3) Email (best-effort; la alerta ya quedó persistida).
    BEGIN
      SELECT u.full_name INTO v_customer FROM users u WHERE u.id = v_ride.customer_id;
      SELECT u.full_name, u.phone INTO v_driver_name, v_driver_tel
      FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
      WHERE dp.id = v_ride.driver_id;

      SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'stuck_ride_alert_email';
      IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
        SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
      END IF;

      IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
        v_service_key := get_service_role_key();
        v_headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key);

        v_subject := '[TriciGo] Viaje trabado #' || left(v_ride.id::text, 8)
          || CASE WHEN v_reason = 'complete_blocked'
               THEN ' — conductor bloqueado al finalizar'
               ELSE ' — detenido con chat activo' END;

        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#d97706;border-bottom:2px solid #d97706;padding-bottom:8px">Viaje posiblemente trabado</h2>'
          || '<p>'
          || CASE WHEN v_reason = 'complete_blocked'
               THEN 'La app del conductor registró <b>intentos de finalizar bloqueados por distancia al pin</b> (validation_events <code>complete_blocked_distance</code>). Puede ser un pin de destino mal geocodificado — mismo patrón del incidente b428022b.'
               ELSE 'El conductor lleva <b>&ge;' || (v_win_s / 60)::text || ' min detenido</b> con el viaje abierto y hay <b>chat reciente</b> entre las partes. Suele significar que están resolviendo a mano algo que la app no deja hacer.'
             END
          || '</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Viaje</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">#' || left(v_ride.id::text, 8) || ' (' || v_ride.status || ')</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Cliente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_customer, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Conductor</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_driver_name, '—') || ' ' || COALESCE(v_driver_tel, '') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Origen</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ride.pickup_address, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Destino</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ride.dropoff_address, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Detectado (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><a href="https://admin.tricigo.com/rides/' || v_ride.id::text || '" '
          || 'style="display:inline-block;background:#d97706;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Ver viaje en el admin</a></p>'
          || '<p style="color:#777;font-size:12px">Watchdog de viajes trabados (00538). Se alerta una sola vez por viaje. No responder.</p>'
          || '</body></html>';

        FOR v_rcpt IN
          SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
          WHERE position('@' IN x) > 0
        LOOP
          PERFORM public.cron_http_post('stuck-ride-alert', 
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

        UPDATE stuck_ride_alerts SET emailed_at = v_now WHERE ride_id = v_ride.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'stuck-ride email failed for ride %: % %', v_ride.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'alerted', v_alerted, 'resolved', v_resolved, 'emails_sent', v_sent);

END;
$function$
;

