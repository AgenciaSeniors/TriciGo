-- ============================================================
-- BUG-106: `create_rides_for_recurring` cron job has been failing
-- every 15 minutes with:
--   ERROR: column "last_ride_created_at" does not exist
--
-- Multiple column mismatches between the function and the table:
--   function uses           | table actually has
--   ------------------------+-----------------------------
--   last_ride_created_at    | last_triggered_at
--   pickup_location (geom)  | pickup_latitude + pickup_longitude
--   dropoff_location (geom) | dropoff_latitude + dropoff_longitude
--   timezone                | <column does not exist>
--   days_of_week::smallint[]| days_of_week is int4[]
--
-- Impact: recurring rides have never been created for any user.
-- Feature is dormant (0 recurring_rides rows in prod today).
-- Fix is a rewrite against the real schema.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_rides_for_recurring()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_next TIMESTAMPTZ;
  v_pickup GEOGRAPHY;
  v_dropoff GEOGRAPHY;
BEGIN
  FOR v_rec IN
    SELECT * FROM recurring_rides
    WHERE status = 'active'
      AND next_occurrence_at IS NOT NULL
      AND next_occurrence_at <= NOW() + interval '24 hours'
      AND (last_triggered_at IS NULL
           OR last_triggered_at < next_occurrence_at - interval '25 hours')
  LOOP
    v_pickup  := ST_SetSRID(ST_MakePoint(v_rec.pickup_longitude::float8,  v_rec.pickup_latitude::float8),  4326)::geography;
    v_dropoff := ST_SetSRID(ST_MakePoint(v_rec.dropoff_longitude::float8, v_rec.dropoff_latitude::float8), 4326)::geography;

    INSERT INTO rides (
      customer_id, service_type, payment_method,
      pickup_location, pickup_address, pickup_lat, pickup_lng,
      dropoff_location, dropoff_address, dropoff_lat, dropoff_lng,
      estimated_fare_cup, estimated_distance_m, estimated_duration_s,
      is_scheduled, scheduled_at, status
    ) VALUES (
      v_rec.customer_id, v_rec.service_type, v_rec.payment_method::payment_method,
      v_pickup, v_rec.pickup_address, v_rec.pickup_latitude::float8, v_rec.pickup_longitude::float8,
      v_dropoff, v_rec.dropoff_address, v_rec.dropoff_latitude::float8, v_rec.dropoff_longitude::float8,
      0, 0, 0, true, v_rec.next_occurrence_at, 'searching'
    );

    v_next := compute_next_occurrence(
      v_rec.days_of_week::smallint[],
      v_rec.time_of_day,
      'America/Havana'::text,
      v_rec.next_occurrence_at + interval '1 hour'
    );

    UPDATE recurring_rides
      SET last_triggered_at = NOW(),
          next_occurrence_at = v_next,
          updated_at = NOW()
    WHERE id = v_rec.id;

    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;
