-- ============================================================
-- 00457 — Fix lost & found notification routing + icon
-- ============================================================
--
-- BUG (found in the pass-2 audit, grounded against the LIVE prod body):
-- notify_lost_item_change() sends all 4 lost-item push notifications with
--   category := 'system'
--   data     := { route: '/trip|/ride/<ride_id>', lost_item_id: <id> }
--
-- But the 3 inbox tap handlers (client/driver/web) route by data.ride_id
-- first (which is ABSENT here → falls through to the home tab), never read
-- data.route, and the magnifier icon is keyed on notification type
-- 'lost_item' (which never arrives because the category is 'system'). So a
-- lost-item notification tap is a dead-end (lands on home) and shows the
-- generic info icon instead of the magnifier.
--
-- Fix: category := 'lost_item' (icon) + add data.ride_id (navigation →
-- the ride/trip screen). route/lost_item_id are kept (harmless, unread).
-- Server-only — no app rebuild. Reproduces the live body verbatim with
-- those two surgical changes in each of the 4 push calls.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_lost_item_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_service_key text := get_service_role_key();
  v_headers jsonb;
BEGIN
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', v_service_key,
    'Authorization', 'Bearer ' || v_service_key
  );

  IF TG_OP = 'INSERT' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.driver_id::text,
        'title', 'Objeto perdido reportado',
        'body', 'Un pasajero reportó un objeto perdido en tu último viaje',
        'data', jsonb_build_object('ride_id', NEW.ride_id::text, 'route', '/trip/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'lost_item'
      )
    );
    RETURN NEW;
  END IF;

  IF NEW.driver_found IS NOT NULL AND (OLD.driver_found IS NULL) THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', CASE WHEN NEW.driver_found THEN 'Objeto encontrado' ELSE 'Objeto no encontrado' END,
        'body', CASE WHEN NEW.driver_found THEN 'El conductor encontró tu objeto. Se coordinará la devolución.' ELSE 'El conductor no encontró el objeto en el vehículo.' END,
        'data', jsonb_build_object('ride_id', NEW.ride_id::text, 'route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'lost_item'
      )
    );
  END IF;

  IF NEW.status = 'return_arranged' AND OLD.status != 'return_arranged' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Devolución coordinada',
        'body', 'Se ha coordinado la devolución de tu objeto',
        'data', jsonb_build_object('ride_id', NEW.ride_id::text, 'route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'lost_item'
      )
    );
  END IF;

  IF NEW.status = 'returned' AND OLD.status != 'returned' THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', NEW.reporter_id::text,
        'title', 'Objeto devuelto',
        'body', 'Tu objeto ha sido devuelto exitosamente',
        'data', jsonb_build_object('ride_id', NEW.ride_id::text, 'route', '/ride/' || NEW.ride_id::text, 'lost_item_id', NEW.id::text),
        'category', 'lost_item'
      )
    );
  END IF;

  RETURN NEW;
END;
$$;
