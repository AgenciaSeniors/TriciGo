-- Function bodies as in prod on 2026-11-07 (pg_get_functiondef, byte for byte), with prod's EXECUTE
-- grants (proacl). run.sh checks their md5(prosrc) against prod's before anything else (F0).
-- The helpers 00683 calls; the bodies part 2 patches (_support_alert, request_ride_help) and the
-- cron function that calls _support_alert (notify_support_waiting_rides, with the two helpers it
-- needs). Part 3: the seven assist actions it guards, the two contexts it extends, the banner's v1
-- and _ops_allow (what they call and 00683 does not touch is stubbed at the end of tables.sql).

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

-- Part 3 (captured 2026-11-09, md5 as on 2026-11-07; all re-confirmed on 2026-11-14 after Moto
-- Deportiva, which patched none of them): _ops_allow, the seven assist actions it
-- guards, the two contexts it extends, and the banner's v1 (unchanged, read next to v2).
CREATE OR REPLACE FUNCTION public._ops_allow(p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_cur text := COALESCE(pg_catalog.current_setting('app.ops_targets', true), '');
BEGIN
  PERFORM pg_catalog.set_config('app.ops_targets',
    pg_catalog.concat_ws(',', NULLIF(v_cur, ''), pg_catalog.array_to_string(p_ids, ',')), true);
END
$function$
;

CREATE OR REPLACE FUNCTION public.admin_offer_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin           uuid := auth.uid();
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_offer           public.ride_offers%ROWTYPE;
  v_expires         timestamptz;
  v_dist            double precision;
  v_mode            text;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;
  -- Not before its time: a driver who accepts a ride hours early is cancelled by
  -- stale_pre_pickup (00282). The predicate of on_ride_insert_dispatch.
  IF COALESCE(v_ride.is_scheduled, false) AND v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'scheduled_at', v_ride.scheduled_at);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  -- 00671: nobody assists a ride they ride in, or offers a ride to themselves.
  IF v_admin = v_ride.customer_id OR v_admin = v_dp.user_id THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT COALESCE((SELECT u.is_active FROM public.users u WHERE u.id = v_dp.user_id), false) THEN
    RETURN jsonb_build_object('error', 'driver_inactive');
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337): the driver could not accept it anyway.
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  v_expires := now() + make_interval(secs => GREATEST(30, public.get_platform_config_numeric('support_offer_ttl_s', 120)::int));
  v_dist := ST_Distance(v_dp.current_location, v_ride.pickup_location);

  SELECT * INTO v_offer FROM public.ride_offers
   WHERE ride_id = p_ride_id AND driver_profile_id = p_driver_profile_id
   FOR UPDATE;

  -- The driver already accepted this ride once (it went back to searching, 00542). Moving that
  -- row off 'accepted' would lower their acceptance_rate for good (00555); "Asignar directo"
  -- gives them the ride instead.
  IF FOUND AND v_offer.status = 'accepted' THEN
    RETURN jsonb_build_object('error', 'offer_already_accepted');
  END IF;

  IF v_offer.id IS NULL THEN
    -- trg_notify_driver_new_offer pushes it like any dispatched offer.
    INSERT INTO public.ride_offers (ride_id, driver_profile_id, distance_m, expires_at)
    VALUES (p_ride_id, p_driver_profile_id, v_dist, v_expires);
    v_mode := 'created';
  ELSIF v_offer.status = 'pending' AND v_offer.expires_at > now() THEN
    -- Already on the driver's screen: give it the support TTL, without a second push.
    UPDATE public.ride_offers SET expires_at = GREATEST(expires_at, v_expires) WHERE id = v_offer.id;
    v_mode := 'extended';
  ELSE
    -- Re-armed through 'expired', so trg_notify_driver_reoffer (expired -> pending) pushes it.
    IF v_offer.status <> 'expired' THEN
      UPDATE public.ride_offers SET status = 'expired' WHERE id = v_offer.id;
    END IF;
    UPDATE public.ride_offers
       SET status = 'pending', expires_at = v_expires, distance_m = v_dist, responded_at = NULL
     WHERE id = v_offer.id;
    v_mode := 'rearmed';
  END IF;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_admin, 'support_offer_ride', 'ride', p_ride_id::text,
          CASE WHEN v_offer.id IS NULL THEN NULL ELSE jsonb_build_object('offer_status', v_offer.status) END,
          jsonb_build_object('driver_profile_id', p_driver_profile_id, 'mode', v_mode, 'expires_at', v_expires));

  RETURN jsonb_build_object('success', true, 'mode', v_mode, 'expires_at', v_expires);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_assign_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin           uuid := auth.uid();
  v_reason          text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride            public.rides%ROWTYPE;
  v_dp              public.driver_profiles%ROWTYPE;
  v_active_id       uuid;
  v_afford          jsonb;
  v_fleet_required  boolean := false;
  v_driver_in_fleet boolean := false;
  v_key             text;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_not_searching', 'status', v_ride.status);
  END IF;
  -- As for an offer: stale_pre_pickup (00282) would cancel a ride accepted hours early.
  IF COALESCE(v_ride.is_scheduled, false) AND v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'scheduled_at', v_ride.scheduled_at);
  END IF;

  SELECT * INTO v_dp FROM public.driver_profiles WHERE id = p_driver_profile_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;
  -- 00671: nobody assists a ride they ride in, or assigns a ride to themselves.
  IF v_admin = v_ride.customer_id OR v_admin = v_dp.user_id THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);
  IF v_dp.status <> 'approved' THEN
    RETURN jsonb_build_object('error', 'driver_not_approved', 'driver_status', v_dp.status);
  END IF;
  IF NOT COALESCE((SELECT u.is_active FROM public.users u WHERE u.id = v_dp.user_id), false) THEN
    RETURN jsonb_build_object('error', 'driver_inactive');
  END IF;
  IF NOT v_dp.is_online THEN
    RETURN jsonb_build_object('error', 'not_online');
  END IF;
  IF v_dp.last_heartbeat_at IS NOT NULL AND v_dp.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error', 'stale_heartbeat', 'last_heartbeat_at', v_dp.last_heartbeat_at);
  END IF;
  IF NOT public._driver_can_serve_ride(v_dp.id, v_ride.service_type,
                                        v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria') THEN
    RETURN jsonb_build_object('error', 'wrong_vehicle_type');
  END IF;
  IF public._users_blocked(v_ride.customer_id, v_dp.user_id) THEN
    RETURN jsonb_build_object('error', 'blocked');
  END IF;

  -- Fleet gate, as accept_ride_v2 (00337).
  IF v_ride.corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.corporate_accounts ca
      WHERE ca.id = v_ride.corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM public.fleet_members fm
          JOIN public.driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL)
    ) INTO v_fleet_required;
    IF v_fleet_required THEN
      SELECT EXISTS (
        SELECT 1 FROM public.fleet_members fm
        JOIN public.driver_fleets df ON df.id = fm.fleet_id
        WHERE df.corporate_account_id = v_ride.corporate_account_id
          AND fm.driver_id = v_dp.user_id
          AND fm.status = 'active'
      ) INTO v_driver_in_fleet;
      IF NOT v_driver_in_fleet THEN
        RETURN jsonb_build_object('error', 'not_in_fleet');
      END IF;
    END IF;
  END IF;

  SELECT a.id INTO v_active_id FROM public.rides a
   WHERE a.driver_id = v_dp.id
     AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
     AND a.id <> p_ride_id
   LIMIT 1;
  IF v_active_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'busy', 'active_ride_id', v_active_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.service_type_configs WHERE slug = v_ride.service_type AND is_active) THEN
    RETURN jsonb_build_object('error', 'service_config_missing');
  END IF;

  -- 00677: the company pays the commission on a company ride, not the driver.
  IF v_ride.payment_method::text = 'corporate' AND v_ride.corporate_account_id IS NOT NULL THEN
    v_afford := NULL;
  ELSE
    v_afford := public.driver_can_afford_commission(v_dp.id, v_ride.estimated_fare_cup);
  END IF;
  IF NOT COALESCE((v_afford->>'ok')::boolean, true) THEN
    RETURN jsonb_build_object('error', 'insufficient_balance',
      'balance_trc', (v_afford->>'balance_trc')::int, 'required_trc', (v_afford->>'required_trc')::int);
  END IF;

  BEGIN
    UPDATE public.rides
       SET driver_id              = v_dp.id,
           status                 = 'accepted',
           accepted_at            = now(),
           driver_custom_rate_cup = v_dp.custom_per_km_rate_cup
     WHERE id = p_ride_id AND status = 'searching';
  EXCEPTION WHEN unique_violation THEN
    -- rides_one_active_per_driver: the driver took another ride a moment ago.
    RETURN jsonb_build_object('error', 'busy', 'race', true);
  END;

  UPDATE public.ride_offers SET status = 'accepted', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id = v_dp.id AND status = 'pending';
  UPDATE public.ride_offers SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND driver_profile_id <> v_dp.id AND status = 'pending';
  UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
   WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_assign_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', 'searching'),
          jsonb_build_object('status', 'accepted', 'driver_profile_id', v_dp.id),
          v_reason);

  -- The driver's push. Category system is always delivered; send-push overwrites data.type with
  -- the category, so the event travels in data.event. Driver apps from 1.7.4 load the trip when
  -- it arrives; older ones load it when the app comes back to the foreground. In a block of its
  -- own, like notify_driver_new_offer: a failing push must not take back the assignment.
  BEGIN
    v_key := public.get_service_role_key();
    IF v_key IS NULL OR v_key = '' THEN
      RAISE WARNING 'admin_assign_ride_to_driver: no service role key, no push for ride %', p_ride_id;
      PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
        jsonb_build_object('driver_profile_id', v_dp.id, 'error', 'no service role key'));
    ELSE
      PERFORM public.cron_http_post('support-assign-push',
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || v_key, 'apikey', v_key),
        body    := jsonb_build_object(
          'user_id', v_dp.user_id::text,
          'title', 'Soporte te asignó un viaje',
          'body', 'Recogida: ' || left(COALESCE(v_ride.pickup_address, '—'), 60)
                  || ' · ' || COALESCE(v_ride.estimated_fare_cup, 0) || ' CUP. Abre la app.',
          'category', 'system',
          'data', jsonb_build_object('event', 'ride_assigned', 'ride_id', p_ride_id::text)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'admin_assign_ride_to_driver: the push for ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_assign_ride_to_driver', v_admin, p_ride_id, 'push_failed',
      jsonb_build_object('driver_profile_id', v_dp.id, 'error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'driver_profile_id', v_dp.id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_change_ride_service(p_ride_id uuid, p_service_type text, p_fare_cup integer, p_mode text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin  uuid := auth.uid();
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_ride   public.rides%ROWTYPE;
  v_err    text;
  v_ttl    integer;
  v_prop   public.ride_service_proposals%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('propose', 'apply') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_mode = 'apply' AND v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  -- 00671: nobody assists a ride they ride in or drive.
  IF v_admin = v_ride.customer_id
     OR v_admin = (SELECT dp.user_id FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id) THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  v_err := public._ride_service_change_error(v_ride, p_service_type, p_fare_cup);
  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('error', v_err, 'status', v_ride.status);
  END IF;

  IF p_mode = 'propose' THEN
    v_ttl := GREATEST(60, public.get_platform_config_numeric('support_proposal_ttl_s', 180)::int);
    UPDATE public.ride_service_proposals SET status = 'superseded', responded_at = now()
     WHERE ride_id = p_ride_id AND status = 'pending';
    INSERT INTO public.ride_service_proposals
      (ride_id, from_service_type, to_service_type, from_fare_cup, to_fare_cup, proposed_by, expires_at)
    VALUES
      (p_ride_id, v_ride.service_type, p_service_type, COALESCE(v_ride.estimated_fare_cup, 0), p_fare_cup,
       v_admin, now() + make_interval(secs => v_ttl))
    RETURNING * INTO v_prop;
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
    VALUES (v_admin, 'support_propose_service', 'ride', p_ride_id::text,
            jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup),
            jsonb_build_object('service_type', p_service_type, 'estimated_fare_cup', p_fare_cup, 'proposal_id', v_prop.id),
            v_reason);
    RETURN jsonb_build_object('success', true, 'mode', 'propose',
                              'proposal_id', v_prop.id, 'expires_at', v_prop.expires_at);
  END IF;

  PERFORM public._ops_allow(ARRAY[p_ride_id]);
  PERFORM public._apply_ride_service_change(p_ride_id, p_service_type, p_fare_cup);
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  SELECT v_admin, 'support_change_service', 'ride', p_ride_id::text,
         jsonb_build_object('service_type', v_ride.service_type, 'estimated_fare_cup', v_ride.estimated_fare_cup,
                            'discount_amount_cup', v_ride.discount_amount_cup),
         jsonb_build_object('service_type', r.service_type, 'estimated_fare_cup', r.estimated_fare_cup,
                            'discount_amount_cup', r.discount_amount_cup),
         v_reason
  FROM public.rides r WHERE r.id = p_ride_id;
  RETURN jsonb_build_object('success', true, 'mode', 'apply');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_release_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_reopened integer;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The driver first, then the ride: the order of release_rides_from_dead_drivers
  -- (block A) and update_driver_position, so a release never deadlocks with them.
  -- NO KEY UPDATE is the lock the UPDATE below needs (it touches no key) and the
  -- one block A's own UPDATE of the driver takes, so they queue behind each other
  -- the same way. FOR UPDATE would also hold back the foreign-key checks of rows
  -- that reference this driver.
  PERFORM 1 FROM public.driver_profiles WHERE id = p_expected_driver_id FOR NO KEY UPDATE;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);  -- 00671
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('accepted', 'driver_en_route') THEN
    RETURN jsonb_build_object('error', 'ride_not_releasable', 'status', v_ride.status);
  END IF;
  IF v_ride.scheduled_at IS NOT NULL AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  -- He reconnects by hand (the push tells him). No auto_offline_at: the
  -- trigger tg_driver_profiles_shift_intent clears it on any is_online change a
  -- person makes, an admin included.
  UPDATE public.driver_profiles SET is_online = false WHERE id = v_ride.driver_id AND is_online;

  UPDATE public.rides SET
    status = 'searching', driver_id = NULL, accepted_at = NULL,
    searching_seen_at = now(), last_dispatched_at = NULL,
    driver_gps_status = 'healthy', driver_gps_unavailable_at = NULL,
    gps_override_requested_at = NULL, gps_override_confirmed_at = NULL,
    gps_check_distance_m = NULL, driver_custom_rate_cup = NULL,
    proximity_pickup_notified_at = NULL,
    updated_at = now()
  WHERE id = p_ride_id;

  -- The driver's accepted offer stays 'accepted': dispatch never re-offers it,
  -- and the driver's acceptance_rate does not move.
  UPDATE public.ride_offers SET status = 'expired'
   WHERE ride_id = p_ride_id AND driver_profile_id = v_ride.driver_id AND status = 'pending';
  v_reopened := public._reopen_ride_offers(p_ride_id, v_ride.driver_id);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.ride_assist AS ra (ride_id, wait_alert_sent_at, wait_email_sent_at)
  VALUES (p_ride_id, now(), now())
  ON CONFLICT (ride_id) DO UPDATE SET
    wait_alert_sent_at = COALESCE(ra.wait_alert_sent_at, now()),
    wait_email_sent_at = COALESCE(ra.wait_email_sent_at, now());

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_release_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_profile_id', v_ride.driver_id),
          jsonb_build_object('status', 'searching', 'offers_reopened', v_reopened), v_reason);

  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_ride.customer_id,
    'Buscando otro conductor',
    'Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo.',
    'ride', jsonb_build_object('reason', 'support_ride_released'));
  PERFORM public._support_ride_push('admin_release_active_ride', p_ride_id, v_driver_user,
    'Soporte te quitó el viaje',
    'Estamos buscando otro conductor para este viaje. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes.',
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'release'));

  BEGIN
    PERFORM public.dispatch_ride(p_ride_id);
  EXCEPTION WHEN OTHERS THEN
    -- The release stands; retry_dispatch_expired_rides picks it up next minute.
    RAISE WARNING 'admin_release_active_ride: dispatch of ride % failed: % %', p_ride_id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('admin_release_active_ride', v_admin, p_ride_id, 'dispatch_failed',
      jsonb_build_object('error', SQLERRM));
  END;

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', 'searching');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_advance_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_new public.rides%ROWTYPE;
  v_driver_user uuid;
  v_to public.ride_status;
  v_body text;
  v_w record;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);  -- 00671
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status IN ('accepted', 'driver_en_route') AND v_ride.scheduled_at > now() THEN
    RETURN jsonb_build_object('error', 'scheduled_not_due', 'status', v_ride.status);
  END IF;

  IF v_ride.status IN ('accepted', 'driver_en_route') THEN
    v_to := 'arrived_at_pickup';
    v_body := 'Marcamos que llegaste al punto de recogida.';
    UPDATE public.rides
       SET status = v_to, driver_arrived_at = COALESCE(driver_arrived_at, now()), updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'arrived_at_pickup' THEN
    v_to := 'in_progress';
    v_body := 'Marcamos el viaje como iniciado.';
    UPDATE public.rides
       SET status = v_to,
           pickup_at = COALESCE(v_ride.pickup_at,
                                public._ride_gps_departure_at(p_ride_id, v_ride.driver_arrived_at),
                                v_ride.driver_arrived_at, now()),
           updated_at = now()
     WHERE id = p_ride_id;
  ELSIF v_ride.status = 'in_progress' THEN
    -- The driver's app asks for a cargo ride's delivery proof (the recipient's
    -- code and the photo) only while it is in_progress: moved to the destination
    -- without it, the ride could no longer be completed.
    IF COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
         SELECT 1 FROM public.delivery_details dd
         WHERE dd.ride_id = p_ride_id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL) THEN
      RETURN jsonb_build_object('error', 'delivery_proof_missing', 'status', v_ride.status);
    END IF;
    v_to := 'arrived_at_destination';
    v_body := 'Marcamos que llegaste al destino.';
    UPDATE public.rides SET status = v_to, updated_at = now() WHERE id = p_ride_id;
  ELSE
    RETURN jsonb_build_object('error', 'ride_not_advanceable', 'status', v_ride.status);
  END IF;

  SELECT * INTO v_new FROM public.rides WHERE id = p_ride_id;
  -- The wait these times give (0 before pickup): what completion will charge.
  SELECT * INTO v_w FROM public._wait_charge_for(v_new.service_type, v_new.driver_arrived_at, v_new.pickup_at);

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_advance_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status, 'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at),
          jsonb_build_object('status', v_to, 'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
                             'wait_minutes', v_w.wait_minutes, 'wait_cup', v_w.charge),
          v_reason);

  -- The rider already gets the status push from notify_ride_status_change.
  PERFORM public._support_ride_push('admin_advance_active_ride', p_ride_id, v_driver_user,
    'Soporte actualizó tu viaje', v_body,
    'system', jsonb_build_object('event', 'support_ride_update', 'action', 'advance', 'status', v_to));

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_to,
    'driver_arrived_at', v_new.driver_arrived_at, 'pickup_at', v_new.pickup_at,
    'wait_minutes', v_w.wait_minutes, 'billable_minutes', v_w.billable_minutes, 'wait_cup', v_w.charge);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_complete_active_ride(p_ride_id uuid, p_expected_status text, p_expected_driver_id uuid, p_expected_total_cup integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_preview jsonb;
  v_status text;
  v_final integer;
  v_method text;
  v_row_cash integer;
  v_cash integer;
  v_wallet integer;
  v_pay jsonb;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF length(v_reason) < 3 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  -- The ride first, as complete_ride_and_pay does.
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF v_admin = v_ride.customer_id OR v_admin = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);  -- 00671
  IF v_ride.status::text IS DISTINCT FROM p_expected_status
     OR v_ride.driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object('error', 'ride_changed', 'status', v_ride.status);
  END IF;
  IF v_ride.status NOT IN ('in_progress', 'arrived_at_destination') THEN
    RETURN jsonb_build_object('error', 'ride_not_completable', 'status', v_ride.status);
  END IF;
  -- tg_rides_require_delivery_proof lets admins through, so the proof a cargo
  -- ride needs (the recipient's code and the delivery photo) is checked here.
  IF COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
       SELECT 1 FROM public.delivery_details dd
       WHERE dd.ride_id = p_ride_id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL) THEN
    RETURN jsonb_build_object('error', 'delivery_proof_missing', 'status', v_ride.status);
  END IF;
  v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  IF v_preview IS NULL THEN
    RETURN jsonb_build_object('error', 'no_agreed_price', 'status', v_ride.status);
  END IF;
  IF (v_preview->>'total_cup')::integer IS DISTINCT FROM p_expected_total_cup THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'status', v_ride.status,
                              'total_cup', (v_preview->>'total_cup')::integer);
  END IF;

  -- The distance does not change a ride with a snapshot: complete_ride_and_pay
  -- prefers the trail distance and only records it.
  PERFORM public.complete_ride_and_pay(p_ride_id, v_ride.driver_id,
                                       v_ride.estimated_distance_m, v_ride.estimated_duration_s);
  SELECT status::text, final_fare_cup, payment_method::text, COALESCE(cash_amount_cup, 0)
    INTO v_status, v_final, v_method, v_row_cash
  FROM public.rides WHERE id = p_ride_id;
  -- What support tells a driver whose app is down: how much to collect in cash.
  -- Derived from the ride row, not read from complete_ride_and_pay's result: its
  -- cash_amount_cup and wallet_amount_cup are 0 on a cash ride (it fills them
  -- only for a mixed ride, a split and the wallet shortfall of 00637, which turns
  -- the ride into a mixed one), yet the driver collects the whole fare. In the
  -- response, cash_amount_cup is the cash the driver collects and
  -- wallet_amount_cup what the wallets paid. The result is not read at all: a
  -- cast error here would roll back a payment that went through.
  v_cash := CASE v_method WHEN 'cash' THEN v_final WHEN 'mixed' THEN v_row_cash ELSE 0 END;
  v_wallet := CASE WHEN v_method IN ('tricicoin', 'mixed') THEN GREATEST(v_final - v_cash, 0) ELSE 0 END;
  v_pay := jsonb_build_object('final_fare_cup', v_final, 'payment_method', v_method,
                              'cash_amount_cup', v_cash, 'wallet_amount_cup', v_wallet);

  UPDATE public.stuck_ride_alerts SET resolved_at = now() WHERE ride_id = p_ride_id AND resolved_at IS NULL;

  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (v_admin, 'support_complete_ride', 'ride', p_ride_id::text,
          jsonb_build_object('status', v_ride.status),
          jsonb_build_object('status', v_status, 'preview', v_preview) || v_pay,
          v_reason);

  -- No support push: notify_ride_status_change already pushes both on 'completed'.
  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'status', v_status) || v_pay;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_cancel_ride(p_ride_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_ride  rides%ROWTYPE;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  IF v_ride.status IN ('completed', 'canceled') THEN
    RETURN jsonb_build_object('error', 'ride_already_closed', 'status', v_ride.status);
  END IF;

  -- 00671: nobody cancels, as support, a ride they ride in or drive.
  IF v_admin = v_ride.customer_id
     OR v_admin = (SELECT dp.user_id FROM driver_profiles dp WHERE dp.id = v_ride.driver_id) THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;
  PERFORM public._ops_allow(ARRAY[p_ride_id]);

  UPDATE rides SET
    status              = 'canceled',
    canceled_at         = now(),
    canceled_by         = v_admin,
    cancellation_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'admin_cancel')
  WHERE id = p_ride_id;

  UPDATE ride_offers SET status = 'superseded', responded_at = now()
  WHERE ride_id = p_ride_id AND status = 'pending';

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, old_values, new_values, reason)
  VALUES (
    v_admin, 'cancel_ride', 'ride', p_ride_id::text,
    jsonb_build_object('status', v_ride.status),
    jsonb_build_object('status', 'canceled'),
    p_reason
  );

  RETURN jsonb_build_object(
    'success',         true,
    'ride_id',         p_ride_id,
    'previous_status', v_ride.status
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_ride_assist_context(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_out  jsonb;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  SELECT jsonb_build_object(
    'ride', jsonb_build_object(
      'id', v_ride.id, 'code', public._ride_short_code(v_ride.id), 'status', v_ride.status,
      'service_type', v_ride.service_type, 'ride_mode', v_ride.ride_mode,
      'estimated_fare_cup', v_ride.estimated_fare_cup, 'discount_amount_cup', v_ride.discount_amount_cup,
      'payment_method', v_ride.payment_method, 'passenger_count', v_ride.passenger_count,
      'shared_ride', COALESCE(v_ride.shared_ride, false),
      'is_corporate', v_ride.corporate_account_id IS NOT NULL,
      'has_waypoints', EXISTS (SELECT 1 FROM public.ride_waypoints w WHERE w.ride_id = v_ride.id),
      'pickup_address', v_ride.pickup_address, 'dropoff_address', v_ride.dropoff_address,
      'pickup_lat', v_ride.pickup_lat, 'pickup_lng', v_ride.pickup_lng,
      'dropoff_lat', v_ride.dropoff_lat, 'dropoff_lng', v_ride.dropoff_lng,
      'created_at', v_ride.created_at,
      'wait_s', GREATEST(0, floor(extract(epoch FROM now() - GREATEST(v_ride.created_at, v_ride.scheduled_at))))::int,
      'customer_id', v_ride.customer_id, 'customer_name', c.full_name,
      'customer_phone', c.phone, 'customer_is_test', c.is_test),
    'help_requested_at', ra.help_requested_at,
    'offers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'driver_profile_id', o.driver_profile_id, 'driver_name', du.full_name, 'status', o.status,
               'offered_at', o.offered_at, 'expires_at', o.expires_at, 'responded_at', o.responded_at)
             ORDER BY o.offered_at DESC)
      FROM public.ride_offers o
      JOIN public.driver_profiles dp ON dp.id = o.driver_profile_id
      JOIN public.users du ON du.id = dp.user_id
      WHERE o.ride_id = v_ride.id), '[]'::jsonb),
    'proposal', (
      SELECT jsonb_build_object(
               'id', p.id, 'from_service_type', p.from_service_type, 'to_service_type', p.to_service_type,
               'from_fare_cup', p.from_fare_cup, 'to_fare_cup', p.to_fare_cup, 'status', p.status,
               'expires_at', p.expires_at, 'responded_at', p.responded_at, 'created_at', p.created_at)
      FROM public.ride_service_proposals p
      WHERE p.ride_id = v_ride.id
      ORDER BY p.created_at DESC
      LIMIT 1))
  INTO v_out
  FROM public.users c
  LEFT JOIN public.ride_assist ra ON ra.ride_id = v_ride.id
  WHERE c.id = v_ride.customer_id;

  RETURN v_out;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_active_ride_context(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride public.rides%ROWTYPE;
  v_driver_user uuid;
  v_actions text[];
  v_dep timestamptz;
  v_start timestamptz;
  v_source text;
  v_preview jsonb;
  v_proof_missing boolean;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;
  SELECT dp.user_id INTO v_driver_user FROM public.driver_profiles dp WHERE dp.id = v_ride.driver_id;
  IF auth.uid() = v_ride.customer_id OR auth.uid() = v_driver_user THEN
    RETURN jsonb_build_object('error', 'self_ride');
  END IF;

  v_actions := CASE v_ride.status
    WHEN 'accepted' THEN ARRAY['release', 'advance']
    WHEN 'driver_en_route' THEN ARRAY['release', 'advance']
    WHEN 'arrived_at_pickup' THEN ARRAY['advance']
    WHEN 'in_progress' THEN ARRAY['advance', 'complete']
    WHEN 'arrived_at_destination' THEN ARRAY['complete']
    ELSE ARRAY[]::text[] END;
  -- Only what the RPCs accept: a ride scheduled for later is neither released
  -- nor advanced (support cancels it from the ride page).
  IF v_ride.status IN ('accepted', 'driver_en_route') AND v_ride.scheduled_at > now() THEN
    v_actions := array_remove(array_remove(v_actions, 'release'), 'advance');
  END IF;
  -- A cargo ride is completed only with the recipient's code and the delivery
  -- photo (admin_complete_active_ride refuses otherwise). The driver's app asks
  -- for them only while the ride is in_progress, so support does not move it to
  -- the destination either (admin_advance_active_ride refuses that step).
  v_proof_missing := COALESCE(v_ride.ride_mode::text = 'cargo', false) AND NOT EXISTS (
    SELECT 1 FROM public.delivery_details dd
    WHERE dd.ride_id = v_ride.id AND dd.delivery_otp_validated_at IS NOT NULL AND dd.delivery_photo_url IS NOT NULL);
  IF v_proof_missing THEN
    v_actions := array_remove(v_actions, 'complete');
    IF v_ride.status = 'in_progress' THEN
      v_actions := array_remove(v_actions, 'advance');
    END IF;
  END IF;

  IF v_ride.status = 'arrived_at_pickup' THEN
    v_dep := public._ride_gps_departure_at(v_ride.id, v_ride.driver_arrived_at);
    v_start := COALESCE(v_ride.pickup_at, v_dep, v_ride.driver_arrived_at, now());
    v_source := CASE WHEN v_ride.pickup_at IS NOT NULL THEN 'recorded'
                     WHEN v_dep IS NOT NULL THEN 'gps'
                     WHEN v_ride.driver_arrived_at IS NOT NULL THEN 'arrival'
                     ELSE 'now' END;
    v_preview := public._active_ride_charge_preview(v_ride, v_start);
  ELSIF v_ride.status IN ('in_progress', 'arrived_at_destination') THEN
    v_preview := public._active_ride_charge_preview(v_ride, v_ride.pickup_at);
  ELSE
    v_preview := public._active_ride_charge_preview(v_ride, NULL);
  END IF;

  RETURN jsonb_build_object(
    'ride', (SELECT jsonb_build_object(
        'id', v_ride.id, 'code', public._ride_short_code(v_ride.id), 'status', v_ride.status,
        'service_type', v_ride.service_type, 'payment_method', v_ride.payment_method,
        'is_corporate', v_ride.corporate_account_id IS NOT NULL,
        'pickup_address', v_ride.pickup_address, 'dropoff_address', v_ride.dropoff_address,
        'created_at', v_ride.created_at, 'accepted_at', v_ride.accepted_at,
        'driver_arrived_at', v_ride.driver_arrived_at, 'pickup_at', v_ride.pickup_at,
        'scheduled_at', v_ride.scheduled_at, 'estimated_fare_cup', v_ride.estimated_fare_cup,
        'customer_id', v_ride.customer_id, 'customer_name', c.full_name,
        'customer_phone', c.phone, 'customer_is_test', c.is_test)
      FROM public.users c WHERE c.id = v_ride.customer_id),
    'driver', (SELECT jsonb_build_object(
        'driver_profile_id', dp.id, 'full_name', u.full_name, 'phone', u.phone,
        'is_online', dp.is_online, 'last_heartbeat_at', dp.last_heartbeat_at,
        'vehicle_label', (SELECT concat_ws(' · ',
             NULLIF(concat_ws(' ', NULLIF(btrim(v.make), ''), NULLIF(btrim(v.model), '')), ''),
             NULLIF(btrim(v.color), ''), NULLIF(btrim(v.plate_number), ''))
           FROM public.vehicles v WHERE v.driver_id = dp.id AND v.is_active ORDER BY v.created_at DESC LIMIT 1),
        'vehicle_type', (SELECT v.type FROM public.vehicles v
           WHERE v.driver_id = dp.id AND v.is_active ORDER BY v.created_at DESC LIMIT 1))
      FROM public.driver_profiles dp JOIN public.users u ON u.id = dp.user_id
      WHERE dp.id = v_ride.driver_id),
    'last_point', (SELECT jsonb_build_object(
        'recorded_at', le.recorded_at, 'received_at', le.received_at,
        'distance_to_pickup_m', round(ST_Distance(le.location, v_ride.pickup_location))::int,
        'distance_to_dropoff_m', round(ST_Distance(le.location, v_ride.dropoff_location))::int)
      FROM public.ride_location_events le
      WHERE le.ride_id = v_ride.id AND le.driver_id = v_ride.driver_id
      ORDER BY GREATEST(le.recorded_at, le.received_at) DESC, le.recorded_at DESC, le.id DESC LIMIT 1),
    'alert', (SELECT jsonb_build_object('reason', a.reason, 'detected_at', a.detected_at)
      FROM public.stuck_ride_alerts a WHERE a.ride_id = v_ride.id AND a.resolved_at IS NULL),
    'driver_profile_id', v_ride.driver_id,
    'delivery_proof_missing', v_proof_missing,
    'preview', v_preview,
    'start_pickup_at', CASE WHEN v_ride.status = 'arrived_at_pickup' THEN v_start END,
    'start_pickup_source', v_source,
    'allowed_actions', to_jsonb(v_actions));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_support_waiting_rides()
 RETURNS TABLE(ride_id uuid, code text, waiting_since timestamp with time zone, wait_s integer, help_requested_at timestamp with time zone, service_type text, estimated_fare_cup integer, pickup_address text, dropoff_address text, pending_offers integer, is_test boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_after integer := GREATEST(15, public.get_platform_config_numeric('support_alert_after_s', 60)::int);
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id,
         public._ride_short_code(r.id),
         GREATEST(r.created_at, r.scheduled_at),
         GREATEST(0, floor(extract(epoch FROM now() - GREATEST(r.created_at, r.scheduled_at))))::int,
         ra.help_requested_at,
         r.service_type,
         r.estimated_fare_cup,
         r.pickup_address,
         r.dropoff_address,
         (SELECT count(*)::int FROM public.ride_offers o
           WHERE o.ride_id = r.id AND o.status = 'pending' AND o.expires_at > now()),
         c.is_test
  FROM public.rides r
  JOIN public.users c ON c.id = r.customer_id
  LEFT JOIN public.ride_assist ra ON ra.ride_id = r.id
  WHERE r.status = 'searching'
    AND GREATEST(r.created_at, r.scheduled_at) <= now()
    AND (ra.help_requested_at IS NOT NULL
         OR GREATEST(r.created_at, r.scheduled_at) <= now() - make_interval(secs => v_after))
  ORDER BY (ra.help_requested_at IS NULL), GREATEST(r.created_at, r.scheduled_at)
  LIMIT 50;
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
-- Part 3 (proacl on 2026-11-09): _ops_allow the owner only; the actions, the contexts and the
-- banner authenticated and service_role.
REVOKE ALL ON FUNCTION public._ops_allow(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_offer_ride_to_driver(uuid, uuid), public.admin_assign_ride_to_driver(uuid, uuid, text),
  public.admin_change_ride_service(uuid, text, integer, text, text),
  public.admin_release_active_ride(uuid, text, uuid, text), public.admin_advance_active_ride(uuid, text, uuid, text),
  public.admin_complete_active_ride(uuid, text, uuid, integer, text), public.admin_cancel_ride(uuid, text),
  public.admin_ride_assist_context(uuid), public.admin_active_ride_context(uuid), public.admin_support_waiting_rides()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_offer_ride_to_driver(uuid, uuid), public.admin_assign_ride_to_driver(uuid, uuid, text),
  public.admin_change_ride_service(uuid, text, integer, text, text),
  public.admin_release_active_ride(uuid, text, uuid, text), public.admin_advance_active_ride(uuid, text, uuid, text),
  public.admin_complete_active_ride(uuid, text, uuid, integer, text), public.admin_cancel_ride(uuid, text),
  public.admin_ride_assist_context(uuid), public.admin_active_ride_context(uuid), public.admin_support_waiting_rides()
  TO authenticated, service_role;
