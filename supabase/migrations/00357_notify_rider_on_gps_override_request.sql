-- 00357_notify_rider_on_gps_override_request.sql
--
-- BUG: cuando el conductor toca "Llegué" estando a 100-500m del punto, el RPC
-- update_ride_status_v2 (Path B.3) setea rides.gps_override_requested_at y le pide
-- al pasajero que confirme ("¿Tu conductor está acá?"). Pero ese UPDATE NO cambia
-- rides.status (sigue 'driver_en_route' en la recogida), y TODOS los triggers de
-- push/SMS de rides disparan en AFTER UPDATE OF status (trg_push_ride_status,
-- trg_sms_ride_status). No existía ningún trigger sobre gps_override_requested_at,
-- así que al pasajero NO le llegaba ninguna notificación.
--
-- El modal de confirmación del cliente (RideActiveView) solo aparece si la app está
-- en primer plano (realtime + poll de 3s). En el DESTINO el pasajero va en el carro
-- con la app abierta → confirma en segundos. En la RECOGIDA el pasajero espera con el
-- teléfono guardado (app en segundo plano) → nunca ve el modal → nunca confirma → el
-- conductor queda en "Esperando al pasajero" y termina cancelando.
-- (Evidencia prod: rides c36e4907 y 47e82024, 259m, gps_override_confirmed_at NULL,
--  cancelados; uno tras 3m43s de espera.)
--
-- FIX: trigger AFTER UPDATE OF gps_override_requested_at que envía un push al pasajero
-- vía la edge function send-push, replicando el patrón de notify_ride_status_change.
-- El push despierta al pasajero para que abra la app y vea el modal de confirmación.
-- Aplica tanto a recogida como a destino (es inofensivo y consistente en ambos).

CREATE OR REPLACE FUNCTION public.notify_rider_gps_override_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_service_key TEXT;
  v_headers JSONB;
  v_payload JSONB;
  v_data JSONB;
BEGIN
  -- El pasajero es siempre el destinatario de la confirmación.
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_data := jsonb_build_object(
    'type',    'ride',
    'ride_id', NEW.id::text,
    'status',  NEW.status::text
  );

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  v_payload := jsonb_build_object(
    'user_id',  NEW.customer_id::text,
    'title',    '¿Ves a tu conductor?',
    'body',     'Tu conductor dice que está cerca. Abrí la app y confirmá si lo ves.',
    'category', 'ride',
    'data',     v_data
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Un fallo de push NUNCA debe bloquear el UPDATE del ride.
  RAISE WARNING '[notify_rider_gps_override_request] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

-- Dispara solo cuando hay una solicitud de confirmación FRESCA y todavía sin confirmar:
--  - gps_override_requested_at acaba de cambiar a un valor no nulo, y
--  - aún no fue confirmada (confirmed_at NULL, o más vieja que esta nueva solicitud —
--    cubre el caso de un segundo gate en el destino tras una confirmación en la recogida).
-- La confirmación del pasajero (rider_confirm_driver_arrival) actualiza
-- gps_override_confirmed_at, NO gps_override_requested_at, así que no re-dispara este trigger.
DROP TRIGGER IF EXISTS trg_notify_gps_override ON public.rides;
CREATE TRIGGER trg_notify_gps_override
AFTER UPDATE OF gps_override_requested_at ON public.rides
FOR EACH ROW
WHEN (
  NEW.gps_override_requested_at IS NOT NULL
  AND NEW.gps_override_requested_at IS DISTINCT FROM OLD.gps_override_requested_at
  AND (
    NEW.gps_override_confirmed_at IS NULL
    OR NEW.gps_override_confirmed_at < NEW.gps_override_requested_at
  )
)
EXECUTE FUNCTION public.notify_rider_gps_override_request();

COMMENT ON FUNCTION public.notify_rider_gps_override_request() IS
  '00357: empuja al pasajero un push (send-push) cuando el gate GPS pide confirmar la llegada del conductor. Cubre el gap donde la recogida no avisaba al pasajero con la app en segundo plano.';
