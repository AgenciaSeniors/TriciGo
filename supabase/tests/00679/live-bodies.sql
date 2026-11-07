-- Function bodies as in prod on 2026-11-07 (pg_get_functiondef, byte for byte), with prod's EXECUTE
-- grants (proacl). run.sh checks their md5(prosrc) against prod's before anything else (F0).
-- The helpers 00679 calls; the bodies part 2 patches (_support_alert, request_ride_help) and the
-- cron function that calls _support_alert (notify_support_waiting_rides, with the two helpers it
-- needs). The assist actions (md5 list in the plan) join this file with part 3.

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_operator()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is an operator, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'operator';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_ops_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Admins, super admins and operators (00668). No JWT subject: false, with the early return of
  -- is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin', 'operator');
END;
$function$
;

CREATE OR REPLACE FUNCTION public._ride_short_code(p_ride_id uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$ SELECT upper(left(p_ride_id::text, 8)) $function$
;

CREATE OR REPLACE FUNCTION public._ride_type_label(p_service_type text, p_ride_mode text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE WHEN p_ride_mode = 'cargo' THEN 'Envío · ' ELSE '' END
      || COALESCE((SELECT NULLIF(btrim(c.name_es), '') FROM public.service_type_configs c
                    WHERE c.slug = p_service_type),
                  NULLIF(btrim(p_service_type), ''),
                  '—')
$function$
;

CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric DEFAULT NULL::numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;

  -- `#>> '{}'` unwraps the JSONB scalar safely whether it was written
  -- as a string ('"0.15"') or as a JSON number (0.15). Cast to NUMERIC
  -- after.
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;

  RETURN COALESCE(v_out, p_fallback);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$
;

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

CREATE OR REPLACE FUNCTION public.get_platform_config_text(p_key text, p_fallback text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;
  RETURN COALESCE(v_raw #>> '{}', p_fallback);
END;
$function$
;

CREATE OR REPLACE FUNCTION public._support_alert(p_ride_id uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride     public.rides%ROWTYPE;
  v_admins   uuid[];
  v_key      text;
  v_code     text := public._ride_short_code(p_ride_id);
  v_link     text := 'https://admin.tricigo.com/rides/' || p_ride_id::text || '/assist';
  v_wait_min integer;
  v_title    text;
  v_body     text;
BEGIN
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_key := public.get_service_role_key();
  IF v_key IS NULL OR v_key = '' THEN
    RAISE WARNING '_support_alert: no service role key, the % push for ride % was not sent', p_kind, p_ride_id;
    PERFORM public.log_rpc_attempt('_support_alert', auth.uid(), p_ride_id, 'alert_failed',
      jsonb_build_object('kind', p_kind, 'error', 'no service role key'));
    RETURN;
  END IF;

  v_wait_min := GREATEST(0, floor(extract(epoch FROM now() - GREATEST(v_ride.created_at, v_ride.scheduled_at)) / 60))::int;
  v_title := CASE WHEN p_kind = 'help' THEN 'Pasajero pide ayuda · ' ELSE 'Viaje sin conductor · ' END
             || public._ride_type_label(v_ride.service_type, v_ride.ride_mode) || ' · ' || v_code;
  v_body := 'Espera ' || v_wait_min || ' min · '
         || left(COALESCE(v_ride.pickup_address, '—'), 60) || ' → ' || left(COALESCE(v_ride.dropoff_address, '—'), 60);

  SELECT array_agg(u.id) INTO v_admins
  FROM public.users u
  WHERE u.role IN ('admin', 'super_admin', 'operator') AND u.is_active;
  IF v_admins IS NOT NULL THEN
    PERFORM public.cron_http_post(
      CASE WHEN p_kind = 'help' THEN 'support-help-alert' ELSE 'support-wait-alert' END,
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
      body    := jsonb_build_object(
        'user_ids', to_jsonb(v_admins),
        'title', v_title, 'body', v_body, 'category', 'system',
        'data', jsonb_build_object('event', 'support_' || p_kind, 'ride_id', p_ride_id::text, 'url', v_link)));
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- An alert never fails its caller (the rider's button, the cron).
  RAISE WARNING '_support_alert failed for ride %: % %', p_ride_id, SQLSTATE, SQLERRM;
  PERFORM public.log_rpc_attempt('_support_alert', auth.uid(), p_ride_id, 'alert_failed',
    jsonb_build_object('kind', p_kind, 'error', SQLERRM));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.request_ride_help(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_ride   public.rides%ROWTYPE;
  v_sent   timestamptz;
  v_recent integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND OR v_ride.customer_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;

  INSERT INTO public.ride_assist (ride_id, help_requested_at)
  VALUES (p_ride_id, now())
  ON CONFLICT (ride_id) DO UPDATE
    SET help_requested_at = COALESCE(public.ride_assist.help_requested_at, EXCLUDED.help_requested_at)
  RETURNING help_alert_sent_at INTO v_sent;

  IF v_sent IS NULL THEN
    SELECT count(*) INTO v_recent
    FROM public.ride_assist ra
    JOIN public.rides r ON r.id = ra.ride_id
    WHERE r.customer_id = v_uid
      AND ra.ride_id <> p_ride_id
      AND ra.help_alert_sent_at > now() - interval '1 hour';
    IF v_recent < 3 THEN
      UPDATE public.ride_assist SET help_alert_sent_at = now() WHERE ride_id = p_ride_id;
      PERFORM public._support_alert(p_ride_id, 'help');
    ELSE
      PERFORM public.log_rpc_attempt('request_ride_help', v_uid, p_ride_id, 'help_alert_capped',
        jsonb_build_object('help_alerts_last_hour', v_recent));
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'code', public._ride_short_code(p_ride_id));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_support_waiting_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled  boolean := COALESCE(public.get_platform_config_text('support_alert_enabled', 'true'), 'true') <> 'false';
  v_after    integer := GREATEST(15, public.get_platform_config_numeric('support_alert_after_s', 60)::int);
  v_id       uuid;
  v_n        integer := 0;
  v_rec      record;
  v_rows     text := '';
  v_help_ids uuid[] := '{}';
  v_wait_ids uuid[] := '{}';
  v_count    integer;
  v_to_raw   text;
  v_rcpt     text;
  v_key      text;
  v_subject  text;
  v_html     text;
  v_cell     text := 'padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top';
BEGIN
  IF v_enabled THEN
    FOR v_id IN
      SELECT r.id
      FROM public.rides r
      JOIN public.users c ON c.id = r.customer_id
      LEFT JOIN public.ride_assist ra ON ra.ride_id = r.id
      WHERE r.status = 'searching'
        AND NOT c.is_test
        AND GREATEST(r.created_at, r.scheduled_at) <= now() - make_interval(secs => v_after)
        AND GREATEST(r.created_at, r.scheduled_at) > now() - interval '6 hours'
        AND ra.wait_alert_sent_at IS NULL
        AND ra.help_alert_sent_at IS NULL
      ORDER BY GREATEST(r.created_at, r.scheduled_at)
      LIMIT 20
    LOOP
      INSERT INTO public.ride_assist (ride_id, wait_alert_sent_at)
      VALUES (v_id, now())
      ON CONFLICT (ride_id) DO UPDATE SET wait_alert_sent_at = EXCLUDED.wait_alert_sent_at
      WHERE public.ride_assist.wait_alert_sent_at IS NULL AND public.ride_assist.help_alert_sent_at IS NULL;
      IF FOUND THEN
        PERFORM public._support_alert(v_id, 'wait');
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END IF;

  -- The digest, in a block of its own: a failure in it must not take back the pushes above.
  BEGIN
    v_to_raw := public.get_platform_config_text('support_alert_email', '');
    IF position('@' IN COALESCE(v_to_raw, '')) > 0 THEN
      FOR v_rec IN
        SELECT r.id, r.pickup_address, r.dropoff_address,
               public._ride_type_label(r.service_type, r.ride_mode) AS type_label,
               (ra.help_alert_sent_at IS NOT NULL) AS is_help,
               GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at)) / 60))::int AS wait_min
        FROM public.ride_assist ra
        JOIN public.rides r ON r.id = ra.ride_id
        WHERE r.status = 'searching'
          AND ((ra.help_alert_sent_at IS NOT NULL AND ra.help_email_sent_at IS NULL)
               OR (v_enabled AND ra.help_alert_sent_at IS NULL
                   AND ra.wait_alert_sent_at IS NOT NULL AND ra.wait_email_sent_at IS NULL))
        ORDER BY (ra.help_alert_sent_at IS NULL), GREATEST(r.created_at, r.scheduled_at)
        LIMIT 20
      LOOP
        IF v_rec.is_help THEN
          v_help_ids := v_help_ids || v_rec.id;
        ELSE
          v_wait_ids := v_wait_ids || v_rec.id;
        END IF;
        -- What the rider typed is escaped; format() writes a NULL as ''.
        v_rows := v_rows || format(
          '<tr><td style="%1$s"><b>%2$s</b></td><td style="%1$s">%8$s</td><td style="%1$s">%3$s</td><td style="%1$s">%4$s min</td>'
          || '<td style="%1$s">%5$s → %6$s</td><td style="%1$s"><a href="%7$s">Asistir</a></td></tr>',
          v_cell, public._ride_short_code(v_rec.id),
          CASE WHEN v_rec.is_help THEN 'Pidió ayuda' ELSE 'Sin conductor' END,
          v_rec.wait_min,
          public._html_escape(COALESCE(v_rec.pickup_address, '—')),
          public._html_escape(COALESCE(v_rec.dropoff_address, '—')),
          'https://admin.tricigo.com/rides/' || v_rec.id::text || '/assist',
          public._html_escape(v_rec.type_label));
      END LOOP;
      v_count := cardinality(v_help_ids) + cardinality(v_wait_ids);

      IF v_count > 0 THEN
        v_key := public.get_service_role_key();
        IF v_key IS NULL OR v_key = '' THEN
          RAISE WARNING 'notify_support_waiting_rides: no service role key, the alert e-mail for % rides was not sent', v_count;
          PERFORM public.log_rpc_attempt('notify_support_waiting_rides', NULL, NULL, 'alert_failed',
            jsonb_build_object('kind', 'digest', 'rides', to_jsonb(v_help_ids || v_wait_ids),
                               'error', 'no service role key'));
        ELSE
          v_subject := v_count || CASE WHEN v_count = 1 THEN ' viaje necesita' ELSE ' viajes necesitan' END
                       || ' soporte';
          -- Every value is non-null: one NULL in a || chain blanks the whole body (CLAUDE.md, 00577).
          v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#111">'
            || '<h2 style="color:#ff4d00;border-bottom:2px solid #ff4d00;padding-bottom:8px">' || v_subject || '</h2>'
            || '<p>Viajes cuyo pasajero tocó <b>Pedir ayuda</b>, y viajes que llevan más de ' || v_after
            || ' segundos sin conductor. Cada viaje aparece una vez por motivo.</p>'
            || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
            || '<tr style="text-align:left;color:#555"><th style="padding:6px">Código</th><th style="padding:6px">Vehículo</th><th style="padding:6px">Motivo</th>'
            || '<th style="padding:6px">Espera</th><th style="padding:6px">Recorrido</th><th style="padding:6px"></th></tr>'
            || v_rows
            || '</table>'
            || '<p style="color:#777;font-size:12px">Aviso automático de TriciGo (00628): un correo por minuto como máximo. No responder.</p>'
            || '</body></html>';
          IF v_html IS NULL THEN
            RAISE EXCEPTION 'empty alert e-mail';
          END IF;
          FOR v_rcpt IN
            SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
          LOOP
            PERFORM public.cron_http_post('support-alert-email',
              url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
              headers := jsonb_build_object('Content-Type', 'application/json',
                                            'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
              body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', '[TriciGo] ' || v_subject,
                                            -- raw HTML: the legacy path of send-email's resolveTemplate (00503, 00538)
                                            'template', v_html, 'data', '{}'::jsonb));
          END LOOP;
          UPDATE public.ride_assist SET help_email_sent_at = now() WHERE ride_id = ANY (v_help_ids);
          UPDATE public.ride_assist SET wait_email_sent_at = now() WHERE ride_id = ANY (v_wait_ids);
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_support_waiting_rides: the alert e-mail failed: % %', SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('notify_support_waiting_rides', NULL, NULL, 'alert_failed',
      jsonb_build_object('kind', 'digest', 'rides', to_jsonb(v_help_ids || v_wait_ids), 'error', SQLERRM));
  END;

  RETURN v_n;
END;
$function$
;

-- Prod's grants (proacl on 2026-11-07).
--   is_admin: PUBLIC. is_operator, is_ops_staff: anon, authenticated, service_role (not PUBLIC).
--   current_user_role, request_ride_help: authenticated, service_role (00517, 00628). The rest:
--   service_role only.
REVOKE ALL ON FUNCTION public.is_operator(), public.is_ops_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_operator(), public.is_ops_staff() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._ride_short_code(uuid), public._ride_type_label(text, text),
  public.get_platform_config_numeric(text, numeric), public.log_rpc_attempt(text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ride_short_code(uuid), public._ride_type_label(text, text),
  public.get_platform_config_numeric(text, numeric), public.log_rpc_attempt(text, uuid, uuid, text, jsonb)
  TO service_role;
REVOKE ALL ON FUNCTION public._html_escape(text), public.get_platform_config_text(text, text),
  public._support_alert(uuid, text), public.notify_support_waiting_rides()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._html_escape(text), public.get_platform_config_text(text, text),
  public._support_alert(uuid, text), public.notify_support_waiting_rides()
  TO service_role;
REVOKE ALL ON FUNCTION public.request_ride_help(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_ride_help(uuid) TO authenticated, service_role;
