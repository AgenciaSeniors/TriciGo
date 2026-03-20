-- ============================================================================
-- Migration 00054: Remove Hardcoded Service Role JWT from Triggers
-- ============================================================================
-- SECURITY FIX: Replaces 10 occurrences of hardcoded service_role JWT token
-- across 6 migration files with dynamic lookup via current_setting().
--
-- PREREQUISITE: Before deploying, run this once in Supabase SQL Editor:
--   ALTER DATABASE postgres SET app.settings.service_role_key = '<your-key>';
--
-- The Edge Functions already accept `apikey` header for internal call bypass
-- (implemented in H1 fix). We switch from Authorization: Bearer <jwt> to
-- apikey: <service_role_key> which is simpler and doesn't expose JWT tokens.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper function to build pg_net headers with service role key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _internal_api_headers()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', current_setting('app.settings.service_role_key', true)
  );
$$;

-- Grant execute to postgres role (used by triggers)
GRANT EXECUTE ON FUNCTION _internal_api_headers() TO postgres;

-- ---------------------------------------------------------------------------
-- 1. Fix cron job: sync-exchange-rate (00021)
-- ---------------------------------------------------------------------------
-- Unschedule old job and reschedule with dynamic headers
SELECT cron.unschedule('sync-exchange-rate');
SELECT cron.schedule(
  'sync-exchange-rate',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/sync-exchange-rate',
    headers := _internal_api_headers(),
    body := '{}'::jsonb
  ) AS request_id;
  $$
);

-- ---------------------------------------------------------------------------
-- 2. Fix notify_ride_status_change() (00022, lines 117, 125)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_ride_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_headers JSONB;
BEGIN
  v_headers := _internal_api_headers();

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
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      v_body := 'Tu viaje ha terminado. ¡Gracias!';

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
    'data', jsonb_build_object(
      'type', 'ride',
      'ride_id', NEW.id::text,
      'status', NEW.status::text
    )
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

-- ---------------------------------------------------------------------------
-- 3. Fix notify_new_chat_message() (00022, line 197)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_new_chat_message()
RETURNS TRIGGER AS $$
DECLARE
  v_ride RECORD;
  v_recipient_id UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
BEGIN
  SELECT customer_id, driver_id INTO v_ride
  FROM rides WHERE id = NEW.ride_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_sender_name
  FROM users WHERE id = NEW.sender_id;

  IF NEW.sender_id = v_ride.customer_id THEN
    IF v_ride.driver_id IS NOT NULL THEN
      v_recipient_id := get_driver_user_id(v_ride.driver_id);
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    v_recipient_id := v_ride.customer_id;
  END IF;

  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_body_preview := LEFT(NEW.body, 100);
  IF LENGTH(NEW.body) > 100 THEN
    v_body_preview := v_body_preview || '...';
  END IF;

  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := _internal_api_headers(),
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

-- ---------------------------------------------------------------------------
-- 4. Fix notify_ride_status_sms() (00032, line 121)
-- ---------------------------------------------------------------------------
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
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_body := 'TriciGo: El pasajero cancelo el viaje.';
          v_event_type := 'canceled_by_rider';
        ELSE
          RETURN NEW;
        END IF;
      ELSE
        v_recipient_id := NEW.customer_id;
        v_body := 'TriciGo: Tu viaje fue cancelado.';
        v_event_type := 'canceled_by_driver';
      END IF;

    ELSE
      RETURN NEW;
  END CASE;

  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT phone, sms_notifications_enabled
  INTO v_phone, v_sms_enabled
  FROM users
  WHERE id = v_recipient_id;

  IF v_phone IS NULL OR NOT v_sms_enabled THEN
    RETURN NEW;
  END IF;

  IF NOT can_send_sms(v_recipient_id) THEN
    RETURN NEW;
  END IF;

  v_payload := jsonb_build_object(
    'user_id', v_recipient_id::text,
    'phone', v_phone,
    'body', v_body,
    'ride_id', NEW.id::text,
    'event_type', v_event_type
  );

  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
    headers := _internal_api_headers(),
    body := v_payload
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 5. Fix notify_trusted_contacts_on_accept() (00035, line 55)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_trusted_contacts_on_accept()
RETURNS TRIGGER AS $$
DECLARE
  v_contact RECORD;
  v_rider_name TEXT;
  v_share_url TEXT;
  v_sms_body TEXT;
  v_payload JSONB;
  v_headers JSONB;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status <> 'searching' THEN
    RETURN NEW;
  END IF;

  IF NEW.share_token IS NULL THEN
    RETURN NEW;
  END IF;

  v_headers := _internal_api_headers();

  SELECT full_name INTO v_rider_name
  FROM users WHERE id = NEW.customer_id;

  v_share_url := 'https://tricigo.app/track/share/' || NEW.share_token;

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

    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
      headers := v_headers,
      body := v_payload
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 6. Fix notify_lost_item_change() (00041, lines 81, 97, 112, 127)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_lost_item_change()
RETURNS TRIGGER AS $$
DECLARE
  v_headers JSONB;
BEGIN
  v_headers := _internal_api_headers();

  -- Notify driver when item reported
  IF TG_OP = 'INSERT' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.driver_id::text,
        'title', 'Objeto perdido reportado',
        'body', 'Un pasajero reportó un objeto perdido en tu último viaje',
        'data', jsonb_build_object('route', '/trip/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
    RETURN NEW;
  END IF;

  -- Notify rider when driver responds (found or not found)
  IF NEW.driver_found IS NOT NULL AND (OLD.driver_found IS NULL) THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', CASE WHEN NEW.driver_found THEN 'Objeto encontrado' ELSE 'Objeto no encontrado' END,
        'body', CASE WHEN NEW.driver_found THEN 'El conductor encontró tu objeto. Se coordinará la devolución.' ELSE 'El conductor no encontró el objeto en el vehículo.' END,
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  -- Notify rider when return arranged
  IF NEW.status = 'return_arranged' AND OLD.status != 'return_arranged' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Devolución coordinada',
        'body', 'Se ha coordinado la devolución de tu objeto',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  -- Notify rider when item returned
  IF NEW.status = 'returned' AND OLD.status != 'returned' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Objeto devuelto',
        'body', 'Tu objeto ha sido devuelto exitosamente',
        'data', jsonb_build_object('route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'system'
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 7. Fix activate_scheduled_rides() (00042, line 67)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activate_scheduled_rides()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_ride RECORD;
  v_driver RECORD;
  v_activated INTEGER := 0;
  v_pickup_lat DOUBLE PRECISION;
  v_pickup_lng DOUBLE PRECISION;
  v_headers JSONB;
BEGIN
  v_headers := _internal_api_headers();

  FOR v_ride IN
    SELECT
      r.id,
      r.pickup_location,
      r.pickup_address,
      r.dropoff_address,
      r.service_type,
      r.scheduled_at,
      ST_Y(r.pickup_location::geometry) AS lat,
      ST_X(r.pickup_location::geometry) AS lng
    FROM rides r
    WHERE r.is_scheduled = true
      AND r.scheduled_notified = false
      AND r.status = 'searching'
      AND r.scheduled_at IS NOT NULL
      AND r.scheduled_at <= NOW() + interval '10 minutes'
      AND r.scheduled_at > NOW() - interval '5 minutes'
  LOOP
    v_pickup_lat := v_ride.lat;
    v_pickup_lng := v_ride.lng;

    UPDATE rides
    SET scheduled_notified = true
    WHERE id = v_ride.id;

    FOR v_driver IN
      SELECT fbd.user_id
      FROM find_best_drivers(
        v_pickup_lat,
        v_pickup_lng,
        v_ride.service_type,
        5,
        8000
      ) fbd
    LOOP
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := v_headers,
        body := jsonb_build_object(
          'user_id', v_driver.user_id::text,
          'title', 'Viaje programado disponible',
          'body', 'Hay un viaje programado cerca de ti: ' || LEFT(v_ride.pickup_address, 40),
          'data', jsonb_build_object(
            'route', '/trip/' || v_ride.id::text,
            'ride_id', v_ride.id::text,
            'type', 'scheduled_ride'
          ),
          'category', 'ride'
        )
      );
    END LOOP;

    v_activated := v_activated + 1;
  END LOOP;

  RETURN v_activated;
END;
$$;
