-- ============================================================
-- 00022: Push Notification Infrastructure
-- Creates notification_log table and server-side push triggers
-- for ride status changes and chat messages.
-- Uses pg_net to call the send-push Edge Function asynchronously.
-- ============================================================

-- 1. Notification log table (used by notification.service.ts broadcastPush/sendToUser)
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'user',
  target_user_id UUID REFERENCES users(id),
  sent_by UUID REFERENCES users(id),
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_log_created ON notification_log(created_at DESC);
CREATE INDEX idx_notification_log_target ON notification_log(target_user_id) WHERE target_user_id IS NOT NULL;

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "nl_admin_select" ON notification_log FOR SELECT USING (is_admin());
CREATE POLICY "nl_admin_insert" ON notification_log FOR INSERT WITH CHECK (is_admin());

-- 2. Enable pg_net extension (may already exist)
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 3. Helper: resolve driver_profiles.user_id from driver_profiles.id
CREATE OR REPLACE FUNCTION get_driver_user_id(p_driver_profile_id UUID)
RETURNS UUID AS $$
  SELECT user_id FROM driver_profiles WHERE id = p_driver_profile_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 4. Push trigger function for ride status changes
CREATE OR REPLACE FUNCTION notify_ride_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
BEGIN
  -- Determine recipient and message based on new status
  CASE NEW.status
    WHEN 'accepted' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor asignado';
      v_body := 'Un conductor aceptó tu viaje';

    WHEN 'driver_en_route' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor en camino';
      v_body := 'Tu conductor va en camino';

    WHEN 'arrived_at_pickup' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor llegó';
      v_body := 'Tu conductor está en el punto de recogida';

    WHEN 'in_progress' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje iniciado';
      v_body := 'Tu viaje ha comenzado';

    WHEN 'completed' THEN
      -- Notify customer
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      v_body := 'Tu viaje ha terminado. ¡Gracias!';

    WHEN 'canceled' THEN
      -- Determine who to notify: the OTHER party
      IF NEW.canceled_by = NEW.customer_id THEN
        -- Customer canceled → notify driver (if assigned)
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_title := 'Viaje cancelado';
          v_body := 'El pasajero canceló el viaje';
        ELSE
          -- No driver assigned, nothing to notify
          RETURN NEW;
        END IF;
      ELSE
        -- Driver or system canceled → notify customer
        v_recipient_id := NEW.customer_id;
        v_title := 'Viaje cancelado';
        v_body := 'Tu viaje fue cancelado';
      END IF;

    ELSE
      -- Unknown status, skip
      RETURN NEW;
  END CASE;

  -- Skip if no recipient resolved
  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Build payload
  v_payload := jsonb_build_object(
    'user_id', v_recipient_id::text,
    'title', v_title,
    'body', v_body,
    'data', jsonb_build_object(
      'type', 'ride',
      'ride_id', NEW.id::text,
      'status', NEW.status::text
    )
  );

  -- Fire async HTTP POST to send-push Edge Function
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := v_payload
  );

  -- Also notify driver of completion with earnings info
  IF NEW.status = 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
      body := jsonb_build_object(
        'user_id', get_driver_user_id(NEW.driver_id)::text,
        'title', 'Viaje completado',
        'body', 'Viaje completado. ¡Revisa tus ganancias!',
        'data', jsonb_build_object(
          'type', 'ride',
          'ride_id', NEW.id::text,
          'status', 'completed'
        )
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger (fires after the existing trg_enforce_ride_transition BEFORE trigger)
CREATE TRIGGER trg_push_ride_status
  AFTER UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify_ride_status_change();

-- 5. Push trigger function for new chat messages
CREATE OR REPLACE FUNCTION notify_new_chat_message()
RETURNS TRIGGER AS $$
DECLARE
  v_ride RECORD;
  v_recipient_id UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
BEGIN
  -- Get the ride to find the other participant
  SELECT customer_id, driver_id INTO v_ride
  FROM rides WHERE id = NEW.ride_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Get sender name
  SELECT full_name INTO v_sender_name
  FROM users WHERE id = NEW.sender_id;

  -- Determine recipient (the other party)
  IF NEW.sender_id = v_ride.customer_id THEN
    -- Customer sent message → notify driver
    IF v_ride.driver_id IS NOT NULL THEN
      v_recipient_id := get_driver_user_id(v_ride.driver_id);
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    -- Driver sent message → notify customer
    v_recipient_id := v_ride.customer_id;
  END IF;

  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Truncate message body for preview
  v_body_preview := LEFT(NEW.body, 100);
  IF LENGTH(NEW.body) > 100 THEN
    v_body_preview := v_body_preview || '...';
  END IF;

  -- Fire async push
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
    body := jsonb_build_object(
      'user_id', v_recipient_id::text,
      'title', COALESCE(v_sender_name, 'Nuevo mensaje'),
      'body', v_body_preview,
      'data', jsonb_build_object(
        'type', 'chat',
        'ride_id', NEW.ride_id::text
      )
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_push_new_message
  AFTER INSERT ON ride_messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_new_chat_message();
