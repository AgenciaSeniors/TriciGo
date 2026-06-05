-- ============================================================
-- 00383_notif_trigger_categories.sql
--
-- Fase 5 (auditoría). Tres triggers que postean a send-push NO pasaban
-- el parámetro `category`, así que sus notificaciones caían como
-- type='system' en el inbox (ícono genérico + no respetan el toggle de
-- mute de su categoría). La push SIEMPRE llegó (title/body presentes);
-- esto solo corrige la categorización del inbox + las preferencias.
--
--   notify_dispatch_retry          -> category 'ride_matching'
--   notify_new_chat_message        -> category 'chat'
--   notify_payment_intent_failure  -> category 'payment'
--
-- Bonus de seguridad: notify_new_chat_message tenía un service_role JWT
-- HARDCODEADO en los headers (mismo smell que 00041). Se reemplaza por
-- get_service_role_key() (vault), como los otros triggers — así esta
-- migración no commitea un secreto a git.
--
-- Cuerpos copiados verbatim del estado vivo en prod (pg_get_functiondef)
-- con el único cambio del campo `category` (+ vault key en chat). Los
-- CREATE OR REPLACE NO recrean los triggers (siguen attachados).
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_dispatch_retry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service_key TEXT;
  v_headers     JSONB;
  v_body        TEXT;
BEGIN
  IF NEW.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.dispatch_round IS NULL OR OLD.dispatch_round IS NULL THEN RETURN NEW; END IF;
  IF NEW.dispatch_round <= OLD.dispatch_round THEN RETURN NEW; END IF;
  IF NEW.dispatch_round NOT IN (2, 3) THEN RETURN NEW; END IF;
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;

  v_body := CASE NEW.dispatch_round
    WHEN 2 THEN 'Seguimos buscando un conductor cercano. Gracias por tu paciencia.'
    WHEN 3 THEN 'Ampliamos la búsqueda a más conductores. Pronto te confirmamos.'
    ELSE 'Seguimos buscando conductor.'
  END;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
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
      'user_id', NEW.customer_id::text,
      'title',   'Buscando conductor',
      'body',    v_body,
      'category', 'ride_matching',
      'data', jsonb_build_object(
        'type',           'ride_matching',
        'ride_id',        NEW.id::text,
        'dispatch_round', NEW.dispatch_round
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_new_chat_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_recipient_id UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
  v_service_key TEXT;
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

  -- Was a hardcoded service_role JWT (00041-class smell); use vault.
  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key,
      'apikey',        v_service_key
    ),
    body := jsonb_build_object(
      'user_id', v_recipient_id::text,
      'title', COALESCE(v_sender_name, 'Nuevo mensaje'),
      'body', v_body_preview,
      'category', 'chat',
      'data', jsonb_build_object(
        'type', 'chat',
        'ride_id', NEW.ride_id::text
      )
    )
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_payment_intent_failure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_title       TEXT;
  v_body        TEXT;
  v_amount_usd  TEXT;
  v_service_key TEXT;
  v_headers     JSONB;
BEGIN
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
      'category', 'payment',
      'data', jsonb_build_object(
        'type',              'payment',
        'payment_intent_id', NEW.id::text,
        'status',            'failed'
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;
