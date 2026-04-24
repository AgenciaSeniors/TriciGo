-- ============================================================
-- BUG-105: SOS trusted-contact notification was purely client-
-- initiated (`notificationService.notifyTrustedContacts()` called
-- from SafetySheet.tsx / DriverTripView.tsx as fire-and-forget
-- `.catch(() => {})`). If the app crashed between
-- `createSOSReport()` and the notification call, or if the network
-- failed silently, NO emergency contact ever heard about the SOS.
--
-- Fix: add a server-side AFTER INSERT trigger on incident_reports
-- that fires an identical SMS to the user's `auto_share=true` OR
-- `is_emergency=true` trusted_contacts when `type='sos'`. Mirrors
-- the pattern of `notify_trusted_contacts_on_accept` (migration
-- 00035, secured via Vault key in 00054).
--
-- Duplicate SMS is acceptable in an emergency — we'd rather have two
-- alerts than zero. The trigger is gated on `type='sos'` so normal
-- incidents (safety_concern, complaint, etc.) do not spam contacts.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_trusted_contacts_on_sos()
RETURNS TRIGGER
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
BEGIN
  IF NEW.type <> 'sos' THEN
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS incident_reports_notify_sos ON public.incident_reports;
CREATE TRIGGER incident_reports_notify_sos
AFTER INSERT ON public.incident_reports
FOR EACH ROW
EXECUTE FUNCTION public.notify_trusted_contacts_on_sos();

COMMENT ON TRIGGER incident_reports_notify_sos ON public.incident_reports IS
  'BUG-105: server-side safety-net SMS to trusted contacts when an SOS incident is filed. Complements client-side notification in SafetySheet.tsx (may duplicate SMS; duplicate is acceptable in an emergency).';
