-- ============================================================
-- 00474: SOS SMS audit-log fix (found during the 00473 E2E test)
--
-- Live evidence (2026-07-02): an SOS SMS was sent AND delivered
-- (sms_deliveries DLR 'delivered') but its sms_log row was lost:
--   ERROR: null value in column "user_id" of relation "sms_log"
--          violates not-null constraint
-- The notify_trusted_contacts_on_sos trigger never passed user_id
-- in the send-sms payload, and the EF ignores the insert error →
-- EVERY SOS SMS silently skipped the audit log.
--
-- Fixes:
--  1. sms_log.user_id becomes nullable — an audit log must never
--     drop entries because a sender forgot an optional attribution
--     (trusted-contact recipients aren't users anyway).
--  2. notify_trusted_contacts_on_sos (reproduced from the LIVE prod
--     body, 00438 lineage): adds user_id = reported_by, normalizes
--     the contact phone at send time (parity with 00473), and fixes
--     the copy to neutral Spanish ("Síguelo en" / "Llama al 106" —
--     the previous body used rioplatense "Seguilo"/"Llamá").
-- ============================================================

ALTER TABLE public.sms_log ALTER COLUMN user_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_sos()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_contact RECORD;
  v_reporter_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_share_token TEXT;
  v_allowed BOOLEAN;
BEGIN
  IF NEW.type <> 'sos' THEN
    RETURN NEW;
  END IF;

  SELECT allowed INTO v_allowed FROM check_rate_limit('sos:' || NEW.reported_by::text, 1, 60);
  IF NOT COALESCE(v_allowed, true) THEN
    RAISE WARNING '[notify_trusted_contacts_on_sos] throttled SOS fan-out for user % (incident %)', NEW.reported_by, NEW.id;
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_reporter_name FROM users WHERE id = NEW.reported_by;

  IF NEW.ride_id IS NOT NULL THEN
    SELECT share_token INTO v_share_token FROM rides WHERE id = NEW.ride_id;
  END IF;

  IF v_share_token IS NOT NULL THEN
    v_share_url := 'https://tricigo.com/track/share/' || v_share_token;
  ELSE
    v_share_url := '';
  END IF;

  FOR v_contact IN
    SELECT DISTINCT tc.name AS contact_name,
           public._normalize_cuban_phone(tc.phone) AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.reported_by
      AND (tc.auto_share = true OR tc.is_emergency = true)
  LOOP
    v_sms_body := '🚨 ALERTA SOS · TriciGo: ' ||
                  COALESCE(v_reporter_name, 'Un contacto tuyo') ||
                  ' activó el botón de emergencia.' ||
                  CASE WHEN v_share_url <> '' THEN ' Síguelo en: ' || v_share_url ELSE '' END ||
                  ' Llama al 106 si es urgente.';

    v_payload := jsonb_build_object(
      'user_id', NEW.reported_by::text,
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
  RAISE WARNING '[notify_trusted_contacts_on_sos] SOS dispatch FAILED for incident % (user %): % %',
    NEW.id, NEW.reported_by, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;
