-- ============================================================
-- Migration 00134: Ride Receipt Email + Payment Failure Push
--
-- Closes two notification gaps identified in the ride-flow review:
--
--   C1: Email receipt on ride completion.
--       notificationService.sendRideReceipt() already existed in the
--       API layer but had no call-site. Moving the dispatch into a
--       DB trigger guarantees the receipt fires even if the driver
--       app crashes right after marking the ride completed.
--
--   C2: Push notification on payment_intents status = 'failed'.
--       Stripe/Tropipay recharges that fail silently left the client
--       unaware. This trigger notifies the owner so they can retry.
--
-- Both triggers are SECURITY DEFINER and read the service_role key
-- from vault (same pattern as migration 00124). If the secret is
-- missing they skip silently, never block the underlying UPDATE.
-- ============================================================

-- ============================================================
-- C1: Send ride receipt on completion
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_ride_receipt_email()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_email TEXT;
  v_driver_name    TEXT;
  v_snapshot       RECORD;
  v_payload        JSONB;
  v_service_key    TEXT;
  v_headers        JSONB;
  v_distance_km    NUMERIC;
  v_duration_min   NUMERIC;
BEGIN
  -- Only fire on actual transition into 'completed'
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  -- Customer email — skip if missing
  SELECT email INTO v_customer_email
  FROM users
  WHERE id = NEW.customer_id
  LIMIT 1;

  IF v_customer_email IS NULL OR v_customer_email = '' THEN
    RETURN NEW;
  END IF;

  -- Driver full name (optional)
  IF NEW.driver_id IS NOT NULL THEN
    SELECT u.full_name INTO v_driver_name
    FROM driver_profiles dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.id = NEW.driver_id
    LIMIT 1;
  END IF;

  -- Latest pricing snapshot (preferred source for fare breakdown)
  SELECT base_fare,
         per_km_rate,
         per_minute_rate,
         distance_m,
         duration_s,
         surge_multiplier,
         subtotal,
         total
  INTO v_snapshot
  FROM ride_pricing_snapshots
  WHERE ride_id = NEW.id
  ORDER BY created_at DESC
  LIMIT 1;

  v_distance_km  := ROUND(COALESCE(NEW.actual_distance_m, NEW.estimated_distance_m, 0) / 1000.0, 2);
  v_duration_min := ROUND(COALESCE(NEW.actual_duration_s, NEW.estimated_duration_s, 0) / 60.0, 1);

  -- Assemble payload matching renderRideReceipt() in send-email edge fn
  v_payload := jsonb_build_object(
    'template',         'ride_receipt',
    'recipient_email',  v_customer_email,
    'subject',          'Tu recibo de viaje TriciGo',
    'locale',           'es',
    'data', jsonb_build_object(
      'completed_at',      NEW.completed_at,
      'created_at',        NEW.created_at,
      'pickup_address',    NEW.pickup_address,
      'dropoff_address',   NEW.dropoff_address,
      'driver_name',       COALESCE(v_driver_name, ''),
      'service_type',      NEW.service_type,
      'payment_method',    NEW.payment_method,
      'distance_km',       v_distance_km,
      'duration_minutes',  v_duration_min,
      'base_fare',         COALESCE(v_snapshot.base_fare, 0),
      'distance_charge',   COALESCE(
                             ROUND(v_snapshot.per_km_rate * v_snapshot.distance_m / 1000.0),
                             0
                           ),
      'time_charge',       COALESCE(
                             ROUND(v_snapshot.per_minute_rate * v_snapshot.duration_s / 60.0),
                             0
                           ),
      'surge_multiplier',  COALESCE(v_snapshot.surge_multiplier, 1),
      'discount_amount',   0,
      'final_fare',        COALESCE(NEW.final_fare_cup, v_snapshot.total, NEW.estimated_fare_cup, 0),
      'estimated_fare',    NEW.estimated_fare_cup
    )
  );

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;  -- Missing vault secret, skip silently
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  -- Fire-and-forget. pg_net is async so this does not block the UPDATE.
  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers,
    body    := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Receipt email is non-critical; never block ride completion
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_send_ride_receipt ON rides;
CREATE TRIGGER trg_send_ride_receipt
  AFTER UPDATE OF status ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.send_ride_receipt_email();

-- ============================================================
-- C2: Push notification on payment failure
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_payment_intent_failure()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_title       TEXT;
  v_body        TEXT;
  v_amount_usd  TEXT;
  v_service_key TEXT;
  v_headers     JSONB;
BEGIN
  -- Only fire on actual transition into 'failed'
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_amount_usd := CASE
    WHEN NEW.amount_usd IS NOT NULL
      THEN '$' || TO_CHAR(NEW.amount_usd, 'FM999990.00') || ' USD'
    ELSE
      COALESCE(NEW.amount_cup::TEXT, '') || ' CUP'
  END;

  v_title := 'Pago no completado';
  v_body  := 'Tu recarga de ' || v_amount_usd || ' no pudo procesarse. Intentalo nuevamente.';

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    -- Missing vault secret, skip silently (matches migration 00124 pattern).
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := jsonb_build_object(
      'user_id', NEW.user_id::text,
      'title',   v_title,
      'body',    v_body,
      'data', jsonb_build_object(
        'type',              'payment',
        'payment_intent_id', NEW.id::text,
        'status',            'failed'
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Notification is non-critical; never block the UPDATE
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_payment_intent_failure ON payment_intents;
CREATE TRIGGER trg_notify_payment_intent_failure
  AFTER UPDATE OF status ON payment_intents
  FOR EACH ROW
  WHEN (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed')
  EXECUTE FUNCTION public.notify_payment_intent_failure();

-- ============================================================
-- Lock down the helper functions: only triggers / service_role
-- should call them. Mirrors migration 00124.
-- ============================================================
REVOKE EXECUTE ON FUNCTION public.send_ride_receipt_email()      FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.notify_payment_intent_failure() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.send_ride_receipt_email() IS
  'C1: Sends ride receipt email via send-email edge function when a ride completes. Fires AFTER UPDATE on rides.status. Non-blocking.';
COMMENT ON FUNCTION public.notify_payment_intent_failure() IS
  'C2: Sends push notification when a payment_intent flips to failed. The send-push edge function inserts the inbox row.';
