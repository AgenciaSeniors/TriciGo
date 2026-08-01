-- 00538: Watchdog de viajes trabados (Paso 4 del incidente b428022b)
--
-- CONTEXTO. En el incidente, el conductor quedó estacionado en el destino real
-- sin poder finalizar (pin mal geocodificado + candado client-side) y resolvió
-- el cobro por chat con la pasajera. Desde el admin TODO se veía normal: el
-- viaje era un "En progreso" más. Las señales existían en los datos — conductor
-- detenido >5 min con el viaje abierto, chat activo en ese lapso — pero nadie
-- las miraba. Este watchdog las mira.
--
-- SEÑALES (cualquiera dispara la alerta, una vez por viaje):
--   1. 'complete_blocked'  — la app registró validation_events
--      'complete_blocked_distance' (00537): el conductor INTENTÓ finalizar y el
--      candado de proximidad lo bloqueó. Señal directa, sin inferencia. Cubre
--      sobre todo a los APK viejos sin el modal de override.
--   2. 'stationary_chat'   — viaje in_progress/arrived_at_destination con el
--      conductor detenido (rastro GPS quieto ≥ stuck_ride_stationary_min_s
--      dentro de stuck_ride_stationary_radius_m) Y chat reciente entre las
--      partes. Detenido + hablando = están resolviendo a mano algo que la app
--      no deja hacer.
--
-- SQL PURO por el mismo motivo que 00503: la detección corre dentro de la base;
-- el único HTTP es el email (la acción, no la detección). El estado queda en
-- stuck_ride_alerts aunque el envío falle. Alerta UNA vez por viaje (PK ride_id)
-- — sin spam por corrida. La resolución es silenciosa (el viaje llegó a estado
-- terminal → resolved_at; no hay email de "recuperado": el admin ya actuó o el
-- viaje se cerró solo).
--
-- Tunables en platform_config (sin redeploy):
--   stuck_ride_watchdog_enabled     true    kill-switch
--   stuck_ride_alert_email          edua56621636@gmail.com  (CSV admitido)
--   stuck_ride_stationary_min_s     300     ventana de quietud (5 min)
--   stuck_ride_stationary_radius_m  60      radio de "quieto"
--   stuck_ride_chat_window_s        900     chat "reciente" (15 min)

INSERT INTO platform_config (key, value) VALUES
  ('stuck_ride_watchdog_enabled',    to_jsonb(true)),
  ('stuck_ride_alert_email',         to_jsonb('edua56621636@gmail.com'::text)),
  ('stuck_ride_stationary_min_s',    to_jsonb(300)),
  ('stuck_ride_stationary_radius_m', to_jsonb(60)),
  ('stuck_ride_chat_window_s',       to_jsonb(900))
ON CONFLICT (key) DO NOTHING;

-- ── Estado de alertas: una fila por viaje alertado ──────────────────────────
CREATE TABLE IF NOT EXISTS public.stuck_ride_alerts (
  ride_id     uuid PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  reason      text NOT NULL CHECK (reason IN ('complete_blocked', 'stationary_chat')),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  emailed_at  timestamptz,
  resolved_at timestamptz
);

COMMENT ON TABLE public.stuck_ride_alerts IS
  '00538: viajes activos detectados como "trabados" por check_stuck_active_rides(). '
  'Una fila por viaje (de-dup del email). resolved_at se estampa cuando el viaje llega a estado terminal.';

ALTER TABLE public.stuck_ride_alerts ENABLE ROW LEVEL SECURITY;

-- Solo lectura para admins (el banner del panel). Escrituras: únicamente la
-- función SECURITY DEFINER / service_role.
DROP POLICY IF EXISTS stuck_ride_alerts_admin_read ON public.stuck_ride_alerts;
CREATE POLICY stuck_ride_alerts_admin_read
  ON public.stuck_ride_alerts FOR SELECT
  USING (is_admin());

-- ── Detección ───────────────────────────────────────────────────────────────
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
    AND rr.status NOT IN ('in_progress', 'arrived_at_destination');
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
          PERFORM net.http_post(
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

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_stuck_active_rides failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$;

COMMENT ON FUNCTION public.check_stuck_active_rides() IS
  '00538: Watchdog de viajes trabados (Paso 4 incidente b428022b). SQL puro (patrón 00503): '
  'detecta bloqueos de finalización (00537) y conductor-detenido+chat; alerta por email UNA '
  'vez por viaje y deja el estado en stuck_ride_alerts para el banner del admin.';

REVOKE ALL ON FUNCTION public.check_stuck_active_rides() FROM PUBLIC, anon, authenticated;

-- ── Cron: cada 5 minutos. Llamada SQL directa (la regla cron_http_post aplica a
-- crons que invocan Edge Functions vía net.http_post; acá la detección es SQL). ──
SELECT cron.unschedule('check-stuck-rides')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-stuck-rides');

SELECT cron.schedule(
  'check-stuck-rides',
  '*/5 * * * *',
  $cron$SELECT public.check_stuck_active_rides();$cron$
);
