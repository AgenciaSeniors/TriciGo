-- ============================================================================
-- Migration 00095: Proximity-Based & Uber-Style Notifications
-- ============================================================================
-- Adds:
--   1. Dedup columns on rides for proximity notifications
--   2. DB trigger on ride_location_events to detect driver proximity
--   3. Enhanced notify_ride_status_change() with fare in completed push
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema changes — dedup columns on rides
-- ---------------------------------------------------------------------------
ALTER TABLE rides ADD COLUMN IF NOT EXISTS proximity_pickup_notified_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS proximity_dropoff_notified_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS rating_reminder_sent BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Proximity notification trigger on ride_location_events
-- ---------------------------------------------------------------------------
-- Fires on every driver location INSERT. Checks distance to pickup/dropoff
-- and sends push notification when driver is within ~1500m (~2 min urban).
-- Uses atomic UPDATE with WHERE IS NULL for concurrency-safe dedup.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_proximity_notification()
RETURNS TRIGGER AS $$
DECLARE
  v_ride RECORD;
  v_distance_m DOUBLE PRECISION;
  v_rows INTEGER;
  v_headers JSONB;
  v_driver_user_id UUID;
BEGIN
  -- Fetch ride details
  SELECT id, status, customer_id, driver_id,
         pickup_location, dropoff_location,
         proximity_pickup_notified_at, proximity_dropoff_notified_at
  INTO v_ride
  FROM rides
  WHERE id = NEW.ride_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Early return: only relevant during en-route or in-progress
  IF v_ride.status NOT IN ('accepted', 'driver_en_route', 'in_progress') THEN
    RETURN NEW;
  END IF;

  v_headers := _internal_api_headers();

  -- ─── Pickup proximity check ───
  IF v_ride.status IN ('accepted', 'driver_en_route')
     AND v_ride.proximity_pickup_notified_at IS NULL
     AND v_ride.pickup_location IS NOT NULL
  THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.pickup_location);

    IF v_distance_m < 1500 THEN
      -- Atomic dedup: only one concurrent insert wins
      UPDATE rides
      SET proximity_pickup_notified_at = NOW()
      WHERE id = v_ride.id
        AND proximity_pickup_notified_at IS NULL;

      GET DIAGNOSTICS v_rows = ROW_COUNT;

      IF v_rows = 1 THEN
        -- Notify customer: "Driver is ~2 min away"
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object(
            'user_id', v_ride.customer_id::text,
            'title', 'Conductor cerca',
            'body', 'Tu conductor está a ~2 minutos del punto de recogida',
            'data', jsonb_build_object(
              'type', 'proximity',
              'ride_id', v_ride.id::text,
              'proximity_type', 'pickup'
            ),
            'category', 'ride_updates'
          )
        );

        -- Notify driver: "Approaching pickup"
        v_driver_user_id := get_driver_user_id(v_ride.driver_id);
        IF v_driver_user_id IS NOT NULL THEN
          PERFORM net.http_post(
            url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
            headers := v_headers,
            body := jsonb_build_object(
              'user_id', v_driver_user_id::text,
              'title', 'Llegando al punto de recogida',
              'body', 'Estás a ~2 minutos del punto de recogida',
              'data', jsonb_build_object(
                'type', 'proximity',
                'ride_id', v_ride.id::text,
                'proximity_type', 'pickup'
              ),
              'category', 'ride_updates'
            )
          );
        END IF;
      END IF;
    END IF;
  END IF;

  -- ─── Dropoff proximity check ───
  IF v_ride.status = 'in_progress'
     AND v_ride.proximity_dropoff_notified_at IS NULL
     AND v_ride.dropoff_location IS NOT NULL
  THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.dropoff_location);

    IF v_distance_m < 1500 THEN
      UPDATE rides
      SET proximity_dropoff_notified_at = NOW()
      WHERE id = v_ride.id
        AND proximity_dropoff_notified_at IS NULL;

      GET DIAGNOSTICS v_rows = ROW_COUNT;

      IF v_rows = 1 THEN
        -- Notify customer: "Arriving at destination"
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object(
            'user_id', v_ride.customer_id::text,
            'title', 'Llegando a destino',
            'body', 'Estás a ~2 minutos de tu destino',
            'data', jsonb_build_object(
              'type', 'proximity',
              'ride_id', v_ride.id::text,
              'proximity_type', 'dropoff'
            ),
            'category', 'ride_updates'
          )
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger (drop first if exists for idempotency)
DROP TRIGGER IF EXISTS trg_proximity_check ON ride_location_events;
CREATE TRIGGER trg_proximity_check
  AFTER INSERT ON ride_location_events
  FOR EACH ROW
  EXECUTE FUNCTION check_proximity_notification();

-- ---------------------------------------------------------------------------
-- 3. Enhanced notify_ride_status_change() — include fare in completed push
-- ---------------------------------------------------------------------------
-- Redefines the function from migration 00054 with fare amount in body.
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
