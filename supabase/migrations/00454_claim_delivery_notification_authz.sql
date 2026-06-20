-- 00454_claim_delivery_notification_authz.sql
-- Auditoría 2026-06-20 SEGUNDA FASE — AUD2-005 (P3 → P2-ish: abuso de SMS + leak de PII).
--
-- `claim_delivery_notification(p_ride_id)` (SECURITY DEFINER, llamado por la EF notify-delivery-recipient
-- tras aceptar un cargo) gateaba SOLO `IF auth.uid() IS NULL`. Cualquier usuario autenticado podía
-- llamarla para CUALQUIER cargo ride → (a) marca delivery_recipient_notified_at + dispara el SMS al
-- destinatario (costo D7, spam), y (b) la función DEVUELVE recipient_phone / recipient_name /
-- direcciones (PII del destinatario).
--
-- Fix: el claim solo lo puede hacer el DRIVER ASIGNADO del ride (el que entrega) o un admin. Un caller
-- random no matchea el WHERE → 0 filas claimeadas → sin SMS ni PII. Reproducido del cuerpo vivo con el
-- único cambio en el WHERE del CTE `claimed`.

CREATE OR REPLACE FUNCTION public.claim_delivery_notification(p_ride_id uuid)
RETURNS TABLE(ride_id uuid, share_token text, recipient_phone text, recipient_name text, customer_first_name text, pickup_address text, dropoff_address text, estimated_duration_s integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'forbidden: authentication required';
  END IF;
  RETURN QUERY
  WITH claimed AS (
    UPDATE rides r SET delivery_recipient_notified_at = NOW()
    WHERE r.id = p_ride_id AND r.ride_mode = 'cargo'
      AND r.delivery_recipient_notified_at IS NULL
      AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      -- AUD2-005: solo el driver asignado (o admin) puede claimear/notificar.
      AND (
        public.is_admin()
        OR EXISTS (SELECT 1 FROM driver_profiles dp WHERE dp.id = r.driver_id AND dp.user_id = auth.uid())
      )
    RETURNING r.id, r.share_token, r.customer_id, r.pickup_address, r.dropoff_address, r.estimated_duration_s
  )
  SELECT c.id, c.share_token, dd.recipient_phone, dd.recipient_name,
    split_part(COALESCE(u.full_name, ''), ' ', 1)::text,
    c.pickup_address, c.dropoff_address, c.estimated_duration_s
  FROM claimed c
  LEFT JOIN delivery_details dd ON dd.ride_id = c.id
  LEFT JOIN users u ON u.id = c.customer_id;
END;
$function$;
