-- ============================================================================
-- Migration 00035: Auto-share ride with trusted contacts
-- ============================================================================
-- When a ride is accepted, sends SMS to all trusted contacts with auto_share
-- enabled, containing a link to track the ride in real time.
-- Runs AFTER UPDATE because the share_token is already set by the BEFORE
-- trigger in migration 00033.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_trusted_contacts_on_accept()
RETURNS TRIGGER AS $$
DECLARE
  v_contact RECORD;
  v_rider_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
BEGIN
  -- Only proceed if ride was just accepted and has a share token
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN
    RETURN NEW;
  END IF;

  IF NEW.share_token IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get rider name
  SELECT full_name INTO v_rider_name
  FROM users WHERE id = NEW.customer_id;

  -- Build share URL
  v_share_url := 'https://tricigo.app/track/share/' || NEW.share_token;

  -- Loop through auto_share trusted contacts for this rider
  FOR v_contact IN
    SELECT tc.name AS contact_name, tc.phone AS contact_phone
    FROM trusted_contacts tc
    WHERE tc.user_id = NEW.customer_id
      AND tc.auto_share = true
  LOOP
    v_sms_body := COALESCE(v_rider_name, 'Alguien') ||
      ' ha iniciado un viaje con TriciGo. Sigue en tiempo real: ' || v_share_url;

    v_payload := jsonb_build_object(
      'phone', v_contact.contact_phone,
      'body', v_sms_body,
      'ride_id', NEW.id::text,
      'event_type', 'trusted_contact_share'
    );

    -- Fire async HTTP POST to send-sms Edge Function
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := v_payload
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger fires AFTER UPDATE (share_token already written by BEFORE trigger)
CREATE TRIGGER trg_notify_trusted_contacts
  AFTER UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'accepted' AND OLD.status = 'searching')
  EXECUTE FUNCTION notify_trusted_contacts_on_accept();
