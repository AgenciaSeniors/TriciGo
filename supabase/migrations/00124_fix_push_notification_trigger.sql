-- ============================================================
-- Migration 00124: Remove hardcoded service_role JWT from trigger
--
-- Migration 00022 embedded a service_role JWT (exp 2088) directly in
-- notify_ride_status_change(), leaking the secret in every migration
-- backup and the git history. This replaces the hardcoded token with
-- a runtime lookup against Supabase Vault.
--
-- PREREQUISITE (run ONCE in Supabase SQL editor BEFORE deploying
-- this migration):
--
--   SELECT vault.create_secret(
--     '<YOUR_SERVICE_ROLE_KEY>',
--     'service_role_key',
--     'Service role JWT used by notify_ride_status_change trigger'
--   );
--
-- POST-DEPLOY:
--   Rotate the old JWT in Supabase dashboard to invalidate the leaked
--   value that still lives in git history.
-- ============================================================

-- Helper: read the service_role_key from vault. Returns NULL if the
-- secret doesn't exist (trigger will silently skip the push call).
CREATE OR REPLACE FUNCTION public.get_service_role_key()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;
  RETURN v_key;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- Restrict access: nobody but SECURITY DEFINER internals should call this.
REVOKE EXECUTE ON FUNCTION public.get_service_role_key() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_service_role_key() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_service_role_key() FROM anon;

-- Rewrite the trigger to use the vault lookup.
CREATE OR REPLACE FUNCTION public.notify_ride_status_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_headers JSONB;
BEGIN
  CASE NEW.status
    WHEN 'accepted' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor asignado';
      v_body := 'Un conductor acepto tu viaje';
    WHEN 'driver_en_route' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor en camino';
      v_body := 'Tu conductor va en camino';
    WHEN 'arrived_at_pickup' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor llego';
      v_body := 'Tu conductor esta en el punto de recogida';
    WHEN 'in_progress' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje iniciado';
      v_body := 'Tu viaje ha comenzado';
    WHEN 'completed' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      v_body := 'Tu viaje ha terminado. Gracias!';
    WHEN 'canceled' THEN
      IF NEW.canceled_by = NEW.customer_id THEN
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_title := 'Viaje cancelado';
          v_body := 'El pasajero cancelo el viaje';
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
    -- No key configured — skip push silently. Migration header
    -- documents how to install the secret.
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key
  );

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

  IF NEW.status = 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body := jsonb_build_object(
        'user_id', get_driver_user_id(NEW.driver_id)::text,
        'title', 'Viaje completado',
        'body', 'Viaje completado. Revisa tus ganancias!',
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
$$;
