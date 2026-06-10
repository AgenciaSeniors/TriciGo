-- 00402_notif_email_data_correctness.sql
--
-- PASS #3 (DB↔frontend experience audit). Four surgical fixes to notification /
-- email trigger functions. Each body below is reproduced VERBATIM from the live
-- prod definition (pg_get_functiondef) with only the documented change applied —
-- no other behavior touched (per the CREATE OR REPLACE regression discipline in
-- CLAUDE.md).
--
--  1. check_proximity_notification — PROX (P1): used _internal_api_headers()
--     (current_setting('app.settings.service_role_key'), which is NOT set in prod
--     → empty apikey, no Authorization → send-push returns 401 "Missing
--     authorization header"). The "tu conductor está a ~2 min" push NEVER reached
--     the rider/driver. Switched to the vault get_service_role_key() pattern used
--     by every other notify_* trigger, and category 'ride_updates' → 'proximity'.
--  2. send_payment_failed_email — EMAIL-USD (P1): amount fell back to
--     ROUND(amount_usd * 100), turning a $20 USD charge into "2.000 CUP". Convert
--     USD→CUP at the live exchange rate so the CUP email shows a real amount.
--  3. send_driver_payout_email — PAYOUT-BAL (P1): read wallet_accounts balance with
--     no account_type filter (LIMIT 1) → non-deterministic balance in gift/payout
--     emails. Filter to the role wallet that send_gift actually credited
--     (_gift_wallet_type).
--  4. notify_ride_status_change — NOTIF-FARE-SEP (P2): completed-ride push rendered
--     final_fare_cup::TEXT with no thousands separator ("$15000 CUP"). Format with
--     a '.' group separator ("15.000") to match the receipt email.

-- ============================================================
-- 1. check_proximity_notification (PROX)
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_proximity_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD; v_distance_m DOUBLE PRECISION; v_rows INTEGER; v_headers JSONB; v_driver_user_id UUID;
  v_service_key TEXT;
BEGIN
  SELECT id, status, customer_id, driver_id, pickup_location, dropoff_location,
         proximity_pickup_notified_at, proximity_dropoff_notified_at
  INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_ride.status NOT IN ('accepted','driver_en_route','in_progress') THEN RETURN NEW; END IF;

  -- PASS #3 PROX fix: was `v_headers := _internal_api_headers();` which reads
  -- current_setting('app.settings.service_role_key') (unset in prod → empty
  -- apikey + no Authorization → send-push 401). Use the vault service key like
  -- notify_ride_status_change so proximity pushes authenticate.
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  IF v_ride.status IN ('accepted','driver_en_route') AND v_ride.proximity_pickup_notified_at IS NULL
     AND v_ride.pickup_location IS NOT NULL THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.pickup_location);
    IF v_distance_m < 1500 THEN
      UPDATE rides SET proximity_pickup_notified_at = NOW()
      WHERE id = v_ride.id AND proximity_pickup_notified_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object('user_id',v_ride.customer_id::text,'title','Conductor cerca','body','Tu conductor está a ~2 minutos del punto de recogida','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','pickup'),'category','proximity')
        );
        v_driver_user_id := get_driver_user_id(v_ride.driver_id);
        IF v_driver_user_id IS NOT NULL THEN
          PERFORM net.http_post(
            url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
            headers := v_headers,
            body := jsonb_build_object('user_id',v_driver_user_id::text,'title','Llegando al punto de recogida','body','Estás a ~2 minutos del punto de recogida','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','pickup'),'category','proximity')
          );
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_ride.status = 'in_progress' AND v_ride.proximity_dropoff_notified_at IS NULL
     AND v_ride.dropoff_location IS NOT NULL THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.dropoff_location);
    IF v_distance_m < 1500 THEN
      UPDATE rides SET proximity_dropoff_notified_at = NOW()
      WHERE id = v_ride.id AND proximity_dropoff_notified_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object('user_id',v_ride.customer_id::text,'title','Llegando a destino','body','Estás a ~2 minutos de tu destino','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','dropoff'),'category','proximity')
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $function$;

-- ============================================================
-- 2. send_payment_failed_email (EMAIL-USD)
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_payment_failed_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_amount INTEGER;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;
  -- PASS #3 EMAIL-USD fix: was ROUND(amount_usd * 100) → showed a USD charge as a
  -- nonsensical figure ($20 → "2.000 CUP"). Convert USD→CUP at the live rate so
  -- the CUP-denominated email shows the real amount the customer was charged.
  v_amount := COALESCE(NEW.amount_cup, ROUND(NEW.amount_usd * get_current_exchange_rate())::integer);
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_payload := jsonb_build_object(
    'template', 'payment_failed', 'recipient_email', v_email,
    'subject', 'No pudimos procesar tu pago — TriciGo',
    'data', jsonb_build_object('full_name', COALESCE(v_full_name, ''), 'amount_cup', v_amount, 'reason', '')
  );
  v_headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_service_key,'apikey',v_service_key);
  PERFORM net.http_post(url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email', headers := v_headers, body := v_payload);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ============================================================
-- 3. send_driver_payout_email (PAYOUT-BAL)
-- ============================================================
CREATE OR REPLACE FUNCTION public.send_driver_payout_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_email TEXT; v_full_name TEXT; v_role TEXT; v_balance INTEGER;
  v_from_name TEXT;
  v_payload JSONB; v_service_key TEXT; v_headers JSONB;
BEGIN
  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN RETURN NEW; END IF;

  SELECT u.email, u.full_name, u.role::text
  INTO v_email, v_full_name, v_role
  FROM users u WHERE u.id = NEW.to_user_id LIMIT 1;
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;

  -- Gift emails always go out (any positive amount, any active recipient role).
  -- Generic payouts keep the 5000-floor + driver/super_admin role gate.
  IF NOT (NEW.kind = 'gift' AND NEW.reversal_of IS NULL) THEN
    IF NEW.amount < 5000 THEN RETURN NEW; END IF;
    IF v_role NOT IN ('driver','super_admin') THEN RETURN NEW; END IF;
  END IF;

  -- PASS #3 PAYOUT-BAL fix: was `... FROM wallet_accounts WHERE user_id = ... LIMIT 1`
  -- with no account_type → a recipient with multiple wallets got a random balance
  -- in the email. Read the role wallet that send_gift actually credited.
  SELECT balance INTO v_balance FROM wallet_accounts
   WHERE user_id = NEW.to_user_id AND account_type = _gift_wallet_type(NEW.to_user_id) LIMIT 1;
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;

  IF NEW.kind = 'gift' AND NEW.reversal_of IS NULL THEN
    SELECT full_name INTO v_from_name FROM users WHERE id = NEW.from_user_id LIMIT 1;
    v_payload := jsonb_build_object(
      'template', 'gift_received', 'recipient_email', v_email,
      'subject', '🎁 Recibiste un regalo en TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount,
        'from_name', COALESCE(v_from_name, ''),
        'note', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at,
        'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  ELSE
    v_payload := jsonb_build_object(
      'template', 'driver_payout', 'recipient_email', v_email,
      'subject', 'Pago recibido — TriciGo',
      'data', jsonb_build_object(
        'full_name', COALESCE(v_full_name, ''),
        'amount_cup', NEW.amount, 'description', COALESCE(NEW.note, ''),
        'created_at', NEW.created_at, 'new_balance_cup', COALESCE(v_balance, 0)
      )
    );
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key, 'apikey', v_service_key
  );
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
    headers := v_headers, body := v_payload
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- ============================================================
-- 4. notify_ride_status_change (NOTIF-FARE-SEP)
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_ride_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_headers JSONB;
  v_data JSONB;
BEGIN
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
      IF NEW.final_fare_cup IS NOT NULL AND NEW.final_fare_cup > 0 THEN
        -- PASS #3 NOTIF-FARE-SEP fix: was NEW.final_fare_cup::TEXT ("$15000 CUP").
        -- Format with a '.' thousands separator to match the receipt email.
        v_body := 'Pago: $' || replace(to_char(NEW.final_fare_cup, 'FM999,999,999'), ',', '.') || ' CUP. ¡Gracias por viajar con TriciGo!';
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

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  v_payload := jsonb_build_object(
    'user_id',  v_recipient_id::text,
    'title',    v_title,
    'body',     v_body,
    'category', 'ride',
    'data',     v_data
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := v_payload
  );

  IF NEW.status = 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body    := jsonb_build_object(
        'user_id',  get_driver_user_id(NEW.driver_id)::text,
        'title',    'Viaje completado',
        'body',     'Viaje completado. ¡Revisa tus ganancias!',
        'category', 'ride',
        'data', jsonb_build_object(
          'type',    'ride',
          'ride_id', NEW.id::text,
          'status', 'completed'
        )
      )
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_ride_status_change] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;
