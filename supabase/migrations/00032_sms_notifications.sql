-- ============================================================
-- 00032: SMS Notifications Infrastructure
-- Adds opt-in SMS alerts for critical ride events via Twilio.
-- Uses pg_net to call the send-sms Edge Function asynchronously.
-- ============================================================

-- 1. Add SMS preference to users (opt-in, default disabled)
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_notifications_enabled BOOLEAN NOT NULL DEFAULT false;

-- 2. SMS log table for rate-limiting and audit
CREATE TABLE IF NOT EXISTS sms_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  message_body TEXT NOT NULL,
  ride_id UUID REFERENCES rides(id),
  event_type TEXT NOT NULL,
  twilio_sid TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sms_log_user_recent ON sms_log(user_id, created_at DESC);
CREATE INDEX idx_sms_log_created ON sms_log(created_at DESC);

ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sms_log_admin_select" ON sms_log FOR SELECT USING (is_admin());
CREATE POLICY "sms_log_service_insert" ON sms_log FOR INSERT WITH CHECK (true);

-- 3. Rate-limit helper: max N SMS per user per hour
CREATE OR REPLACE FUNCTION can_send_sms(p_user_id UUID, p_max_per_hour INT DEFAULT 5)
RETURNS BOOLEAN AS $$
  SELECT COUNT(*) < p_max_per_hour
  FROM sms_log
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 hour';
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 4. Trigger function for ride status → SMS
CREATE OR REPLACE FUNCTION notify_ride_status_sms()
RETURNS TRIGGER AS $$
DECLARE
  v_recipient_id UUID;
  v_phone TEXT;
  v_sms_enabled BOOLEAN;
  v_body TEXT;
  v_event_type TEXT;
  v_payload JSONB;
BEGIN
  -- Only fire for critical statuses
  CASE NEW.status
    WHEN 'accepted' THEN
      v_recipient_id := NEW.customer_id;
      v_body := 'TriciGo: Un conductor acepto tu viaje. Abre la app para ver detalles.';
      v_event_type := 'accepted';

    WHEN 'arrived_at_pickup' THEN
      v_recipient_id := NEW.customer_id;
      v_body := 'TriciGo: Tu conductor llego al punto de recogida.';
      v_event_type := 'arrived_at_pickup';

    WHEN 'completed' THEN
      v_recipient_id := NEW.customer_id;
      v_body := 'TriciGo: Viaje completado. Gracias por usar TriciGo!';
      v_event_type := 'completed';

    WHEN 'canceled' THEN
      IF NEW.canceled_by = NEW.customer_id THEN
        -- Customer canceled → notify driver
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_body := 'TriciGo: El pasajero cancelo el viaje.';
          v_event_type := 'canceled_by_rider';
        ELSE
          RETURN NEW;
        END IF;
      ELSE
        -- Driver/system canceled → notify customer
        v_recipient_id := NEW.customer_id;
        v_body := 'TriciGo: Tu viaje fue cancelado.';
        v_event_type := 'canceled_by_driver';
      END IF;

    ELSE
      -- Non-critical status (driver_en_route, in_progress) → skip SMS
      RETURN NEW;
  END CASE;

  -- Skip if no recipient
  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if user has SMS enabled
  SELECT phone, sms_notifications_enabled
  INTO v_phone, v_sms_enabled
  FROM users
  WHERE id = v_recipient_id;

  IF v_phone IS NULL OR NOT v_sms_enabled THEN
    RETURN NEW;
  END IF;

  -- Rate-limit check
  IF NOT can_send_sms(v_recipient_id) THEN
    RETURN NEW;
  END IF;

  -- Build payload for send-sms Edge Function
  v_payload := jsonb_build_object(
    'user_id', v_recipient_id::text,
    'phone', v_phone,
    'body', v_body,
    'ride_id', NEW.id::text,
    'event_type', v_event_type
  );

  -- Fire async HTTP POST to send-sms Edge Function
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := v_payload
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Create the trigger (runs alongside the push trigger)
CREATE TRIGGER trg_sms_ride_status
  AFTER UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify_ride_status_sms();
