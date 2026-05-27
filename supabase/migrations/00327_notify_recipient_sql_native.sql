-- 00327_notify_recipient_sql_native.sql
-- ============================================================
-- Bug encontrado por test E2E de Fase C (delivery audit):
-- El trigger 00325 llamaba la EF `notify-delivery-recipient` con
-- `Authorization: Bearer <service_role_key>`. La EF tiene
-- `verify_jwt=true` Y su lógica interna pasa el header al cliente
-- anon (que no levanta service_role). Resultado: 401
-- "UNAUTHORIZED_INVALID_JWT_FORMAT" — el SMS nunca se envía y
-- `delivery_recipient_notified_at` queda NULL.
--
-- Fix: refactor el trigger para hacer todo SQL-native:
--   1. Atomic claim (UPDATE rides SET delivery_recipient_notified_at)
--   2. JOIN para obtener recipient_phone + share_token + customer_first
--   3. Construir SMS body en SQL
--   4. POST directo a `send-sms` (verify_jwt=false, soporta service_role)
--
-- Beneficios vs el approach EF-intermedia:
--   - 1 hop menos (no pasa por notify-delivery-recipient)
--   - No depende de auth.uid() del caller — el trigger es
--     SECURITY DEFINER y opera con permisos del owner
--   - Idempotente por el WHERE delivery_recipient_notified_at IS NULL
--     dentro del UPDATE atómico
--
-- La EF `notify-delivery-recipient` queda deployed pero unused —
-- puede borrarse en otra migration de cleanup, o conservarse por si
-- el driver app la quiere invocar directamente con su JWT (uso
-- original previsto).
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_delivery_recipient_on_accept()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_catalog'
AS $$
DECLARE
  v_service_key TEXT;
  v_headers JSONB;
  v_body TEXT;
  v_share_token TEXT;
  v_recipient_phone TEXT;
  v_recipient_first TEXT;
  v_customer_first TEXT;
  v_eta_s INTEGER;
  v_eta_label TEXT;
  v_claimed_rows INTEGER;
BEGIN
  -- Trigger WHEN clause already restricts to cargo + searching→accepted.
  -- Keep explicit guards for manual invocations.
  IF NEW.ride_mode <> 'cargo' OR NEW.status <> 'accepted' OR OLD.status = 'accepted' THEN
    RETURN NEW;
  END IF;

  -- ATOMIC CLAIM: only one trigger invocation succeeds. Idempotent.
  UPDATE rides
  SET delivery_recipient_notified_at = NOW()
  WHERE id = NEW.id
    AND delivery_recipient_notified_at IS NULL
  RETURNING share_token, estimated_duration_s
  INTO v_share_token, v_eta_s;

  GET DIAGNOSTICS v_claimed_rows = ROW_COUNT;
  IF v_claimed_rows = 0 OR v_share_token IS NULL THEN
    RETURN NEW;  -- already notified or no token (rare race)
  END IF;

  -- Pull recipient + customer context.
  SELECT dd.recipient_phone,
         split_part(COALESCE(dd.recipient_name, ''), ' ', 1),
         split_part(COALESCE(u.full_name, ''), ' ', 1)
  INTO v_recipient_phone, v_recipient_first, v_customer_first
  FROM delivery_details dd
  LEFT JOIN users u ON u.id = NEW.customer_id
  WHERE dd.ride_id = NEW.id
  LIMIT 1;

  IF v_recipient_phone IS NULL OR v_recipient_phone = '' THEN
    -- Phone missing: claim is locked (won't retry) but skip SMS.
    -- Acceptable: the customer can still share the link manually.
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RAISE WARNING '[notify_recipient] service_role_key missing — skipping send-sms for ride %', NEW.id;
    RETURN NEW;
  END IF;

  -- Build SMS body mirroring the EF's logic.
  v_eta_label := CASE
    WHEN v_eta_s IS NOT NULL AND v_eta_s > 0 THEN '~' || CEIL(v_eta_s / 60.0)::text || ' min'
    ELSE NULL
  END;

  v_body := COALESCE(NULLIF(v_recipient_first, ''), 'Hola') || ', ' ||
            COALESCE(NULLIF(v_customer_first, ''), 'un contacto') ||
            ' te envia un paquete via TriciGo.' ||
            CASE WHEN v_eta_label IS NOT NULL THEN ' ETA ' || v_eta_label || '.' ELSE '' END ||
            ' Sigue tu envio: https://tricigo.com/delivery/' || v_share_token;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key
  );

  -- Fire-and-forget POST to send-sms (verify_jwt=false; accepts service_role).
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-sms',
    headers := v_headers,
    body := jsonb_build_object(
      'phone', v_recipient_phone,
      'body', v_body,
      'ride_id', NEW.id::text,
      'event_type', 'delivery_recipient_notify'
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Notification gap must NEVER block ride acceptance.
  RAISE WARNING '[notify_recipient] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_delivery_recipient_on_accept() IS
  '00327 SQL-native refactor: atomic claim + direct POST to send-sms. Replaces 00325 which hit verify_jwt=true on notify-delivery-recipient EF.';

-- Trigger definition unchanged (00325 already created it). We re-DROP+CREATE
-- to ensure cleanliness if migrations are replayed in isolation.
DROP TRIGGER IF EXISTS trg_notify_delivery_recipient ON public.rides;

CREATE TRIGGER trg_notify_delivery_recipient
AFTER UPDATE OF status ON public.rides
FOR EACH ROW
WHEN (
  NEW.status = 'accepted'::ride_status
  AND OLD.status = 'searching'::ride_status
  AND NEW.ride_mode = 'cargo'
)
EXECUTE FUNCTION public.notify_delivery_recipient_on_accept();
