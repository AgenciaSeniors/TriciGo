-- 00425_sos_safety_net_log_failures.sql
-- ============================================================================
-- SF-01 (P1, audit 2026-06-14): notify_trusted_contacts_on_sos is — by its own
-- migration comment (00165) — the server-side LAST line of defense for SOS after
-- the client path was found to be fire-and-forget (BUG-105). Yet its
-- `EXCEPTION WHEN OTHERS THEN RETURN NEW` swallows any failure with ZERO logging.
-- If the SOS dispatch ever throws (schema drift, a vault/key problem, a bad
-- contact row), emergency contacts are silently never alerted and nothing —
-- no log, no cron, no alert — records it. Emergency-path silent failure.
--
-- Fix: keep the non-blocking behavior (an SOS incident INSERT must never be
-- rolled back by a notification failure) but RAISE WARNING so the failure is
-- visible in Postgres logs. Body reproduced verbatim from the live prod
-- function; only the EXCEPTION handler gains the warning.
--
-- (The async send-sms HTTP response is still not inspected here — a non-200 from
-- the provider is captured in net._http_response; a reconciliation cron for SOS
-- alerts is a recommended follow-up. The client/web SOS handlers now also warn
-- the rider when contacts_notified=0 — see SF-02.)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_sos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_contact RECORD;
  v_reporter_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_share_token TEXT;
BEGIN
  -- Only fire for SOS-type incidents
  IF NEW.type <> 'sos' THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  -- If the service key is missing (local dev / test), silently skip —
  -- the client-side fallback still runs.
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_reporter_name FROM users WHERE id = NEW.reported_by;

  -- Include the ride's share token if available so contacts can follow
  -- the location in real time
  IF NEW.ride_id IS NOT NULL THEN
    SELECT share_token INTO v_share_token FROM rides WHERE id = NEW.ride_id;
  END IF;

  IF v_share_token IS NOT NULL THEN
    v_share_url := 'https://tricigo.com/track/share/' || v_share_token;
  ELSE
    v_share_url := '';
  END IF;

  FOR v_contact IN
    SELECT DISTINCT tc.name AS contact_name, tc.phone AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.reported_by
      AND (tc.auto_share = true OR tc.is_emergency = true)
  LOOP
    v_sms_body := '🚨 ALERTA SOS · TriciGo: ' ||
                  COALESCE(v_reporter_name, 'Un contacto tuyo') ||
                  ' activó el botón de emergencia.' ||
                  CASE WHEN v_share_url <> '' THEN ' Seguilo en: ' || v_share_url ELSE '' END ||
                  ' Llamá al 106 si es urgente.';

    v_payload := jsonb_build_object(
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.ride_id,
      'incident_id', NEW.id::text,
      'event_type', 'sos_alert'
    );

    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', v_service_key,
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := v_payload
    );
  END LOOP;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Never block the INSERT of an SOS incident because of a notification
  -- failure (the primary record is the priority) — but DO log it. This is the
  -- server-side last line of defense for SOS, so a silent failure must be
  -- visible in Postgres logs (SF-01).
  RAISE WARNING '[notify_trusted_contacts_on_sos] SOS dispatch FAILED for incident % (user %): % %',
    NEW.id, NEW.reported_by, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;
