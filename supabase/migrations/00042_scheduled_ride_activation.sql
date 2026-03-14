-- ============================================================
-- Migration 00042: Scheduled Ride Activation
-- Adds automated activation of scheduled rides when their
-- scheduled time approaches. Sends push notifications to
-- nearby eligible drivers ~10 minutes before scheduled_at.
-- ============================================================

-- 1. Add tracking column to prevent duplicate notifications
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS scheduled_notified BOOLEAN DEFAULT false;

-- 2. Create activation function
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
BEGIN
  -- Find scheduled rides approaching their time (within 10 min)
  -- that haven't been notified yet
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

    -- Mark as notified immediately to prevent duplicates
    UPDATE rides
    SET scheduled_notified = true
    WHERE id = v_ride.id;

    -- Find best drivers using existing matching function
    -- and send push notification to top 5
    FOR v_driver IN
      SELECT fbd.user_id
      FROM find_best_drivers(
        v_pickup_lat,
        v_pickup_lng,
        v_ride.service_type,
        5,    -- top 5 drivers
        8000  -- 8km radius (wider for scheduled)
      ) fbd
    LOOP
      -- Send push notification to each candidate driver
      PERFORM net.http_post(
        url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxxYXVmc3pidXJxdmxzbHBjdWFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwODQ1NiwiZXhwIjoyMDg4NTg0NDU2fQ.-fBsXIjuuUFW-8FXf8Kq9nA-ZNBli_vk3wcChSf6WzQ"}'::jsonb,
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

-- 3. Schedule cron job to run every 5 minutes
SELECT cron.schedule(
  'activate-scheduled-rides',
  '*/5 * * * *',
  $$ SELECT activate_scheduled_rides(); $$
);

-- 4. Feature flag (reuse existing scheduled ride support, just ensure it's tracked)
INSERT INTO feature_flags (key, value, description)
VALUES ('scheduled_rides_enabled', true, 'Habilitar viajes programados / Scheduled rides')
ON CONFLICT (key) DO NOTHING;
