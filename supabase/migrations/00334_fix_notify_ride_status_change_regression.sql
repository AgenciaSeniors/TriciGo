-- ============================================================
-- 00334_fix_notify_ride_status_change_regression.sql
--
-- Restores two features that were silently dropped when migration
-- 00124 rewrote `notify_ride_status_change` to switch from
-- `_internal_api_headers()` to vault-based `get_service_role_key()`:
--
--   • The `arrived_at_destination` case (originally added by 00096).
--     The enum value exists and is used by 14+ frontend files
--     (ArrivalBanner.tsx, useTripProgress.ts, RideMapView.tsx, etc.)
--     but the customer never received a push when the driver
--     reached the destination.
--
--   • The fare amount in the `completed` push body (originally added
--     by 00095). The body had been "Pago: $X CUP. ¡Gracias por
--     viajar con TriciGo!" with the real final_fare_cup; 00124
--     reverted it to the generic "Tu viaje ha terminado. ¡Gracias!".
--
-- This migration consolidates ALL features into one definitive
-- version: vault auth + arrived_at_destination case + fare body.
-- The trigger `trg_push_ride_status` (created in 00022) keeps
-- pointing at this function — CREATE OR REPLACE swaps the body
-- in place, no trigger recreate needed.
--
-- Idempotent: re-applying this migration is safe (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_ride_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_headers JSONB;
  v_data JSONB;
BEGIN
  -- Build default data payload (extended per-case below for completed)
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

    -- Restored from 00096: notify customer when driver reaches the
    -- destination. Frontend uses this status in 14+ files to render
    -- the arrival banner; without the push, customers who left the
    -- app open in another tab never get the cue.
    WHEN 'arrived_at_destination' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Llegaste a tu destino';
      v_body := 'Tu conductor ha llegado al punto de destino';

    WHEN 'completed' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      -- Restored from 00095: include the final fare in the body so
      -- the customer sees what they paid without opening the app.
      -- Fallback to the generic "thanks" copy if final_fare_cup
      -- hasn't been written yet (paranoia — RPC always sets it).
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

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    -- Vault secret missing — skip silently (same pattern as 00124,
    -- 00134, 00269, 00325, 00332). The state transition is the
    -- source of truth; missing notifications must not abort it.
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

  -- Driver-side completion push with earnings reminder. Unchanged
  -- from prior versions other than passing category='ride' to the
  -- inbox writer (which had been omitted).
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
  -- Defensive: any pg_net hiccup must not break the ride status
  -- update. The trigger fires AFTER UPDATE so the row is already
  -- written; we just lose the notification on rare failures.
  RAISE WARNING '[notify_ride_status_change] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_ride_status_change() IS
  '00334: Consolidated ride-status push trigger. Restores arrived_at_destination case (00096) and fare-in-completed body (00095) that 00124 silently dropped. Uses vault-based service role key.';
