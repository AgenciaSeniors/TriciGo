-- ============================================================================
-- Migration 00096: Arrived at Destination Status
-- ============================================================================
-- Adds:
--   1. 'arrived_at_destination' value to ride_status enum
--   2. Valid transitions for the new status
--   3. Timestamp column on rides
--   4. Updated notify_ride_status_change() with new WHEN case
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add new enum value
-- ---------------------------------------------------------------------------
ALTER TYPE ride_status ADD VALUE IF NOT EXISTS 'arrived_at_destination' AFTER 'in_progress';

-- ---------------------------------------------------------------------------
-- 2. Valid transitions
-- ---------------------------------------------------------------------------
INSERT INTO valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('in_progress', 'arrived_at_destination', ARRAY['driver']::user_role[]),
  ('arrived_at_destination', 'completed', ARRAY['driver', 'admin']::user_role[]),
  ('arrived_at_destination', 'disputed', ARRAY['customer', 'driver']::user_role[])
ON CONFLICT (from_status, to_status) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Timestamp column
-- ---------------------------------------------------------------------------
ALTER TABLE rides ADD COLUMN IF NOT EXISTS arrived_at_destination_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. Enhanced notify_ride_status_change() — add arrived_at_destination case
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_ride_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_headers JSONB;
  v_data JSONB;
BEGIN
  v_headers := _internal_api_headers();

  -- Build default data payload
  v_data := jsonb_build_object(
    'type', 'ride',
    'ride_id', NEW.id::text,
    'status', NEW.status::text
  );

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

    WHEN 'arrived_at_destination' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Llegaste a tu destino';
      v_body := 'Tu conductor ha llegado al punto de destino';

    WHEN 'completed' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      -- Include fare amount in notification body
      IF NEW.final_fare_cup IS NOT NULL AND NEW.final_fare_cup > 0 THEN
        v_body := 'Pago: $' || NEW.final_fare_cup::TEXT || ' CUP. ¡Gracias por viajar con TriciGo!';
        v_data := v_data || jsonb_build_object(
          'final_fare_cup', NEW.final_fare_cup,
          'payment_method', COALESCE(NEW.payment_method, 'cash')
        );
      ELSE
        v_body := 'Tu viaje ha terminado. ¡Gracias!';
      END IF;

    WHEN 'canceled' THEN
      IF NEW.canceled_by = NEW.customer_id THEN
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_title := 'Viaje cancelado';
          v_body := 'El pasajero canceló el viaje';
        ELSE
          RETURN NEW;
        END IF;
      ELSE
        v_recipient_id := NEW.customer_id;
        v_title := 'Viaje cancelado';
        v_body := 'Tu viaje fue cancelado';
      END IF;

    ELSE
      RETURN NEW;
  END CASE;

  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'user_id', v_recipient_id::text,
    'title', v_title,
    'body', v_body,
    'data', v_data
  );

  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body := v_payload
  );

  -- Also notify driver of completion with earnings info
  IF NEW.status = 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
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
