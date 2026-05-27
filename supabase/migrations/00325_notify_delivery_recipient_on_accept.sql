-- 00325_notify_delivery_recipient_on_accept.sql
-- ============================================================
-- Wire the existing `notify-delivery-recipient` Edge Function so it
-- actually fires when a delivery (ride_mode='cargo') is accepted.
--
-- Background — audit finding G2:
--   The EF has been deployed (v8, ACTIVE) and the supporting RPC
--   `claim_delivery_notification(ride_id)` exists, but no caller
--   invoked them. Result: every delivery's `recipient_phone` never
--   received the tracking SMS — recipients only ever learned about
--   the package if the sender forwarded the link manually.
--
-- Fix:
--   AFTER UPDATE trigger that POSTs to the EF whenever a cargo ride
--   transitions from `searching` → `accepted`. Mirrors the pattern
--   already used by `send_delivery_receipt_email` (00xxx):
--     1) Skip if not a cargo ride or not the searching→accepted edge.
--     2) Load the service role key via `get_service_role_key()`
--        (helper added in earlier migration). Silently no-op if
--        missing — never block the ride lifecycle on notifications.
--     3) POST { ride_id } to the EF. The EF internally calls
--        `claim_delivery_notification` (atomic: sets
--        `delivery_recipient_notified_at`) and `send-sms` if a row
--        was claimed.
--
-- Idempotency:
--   - Trigger WHEN clause restricts to the searching→accepted edge.
--   - RPC `claim_delivery_notification` filters
--     `delivery_recipient_notified_at IS NULL`, so even retries from
--     a transient network error never double-send.
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
  v_payload JSONB;
BEGIN
  -- Defensive guard: trigger WHEN clause already restricts, but keep
  -- explicit check so the function is safe even if called manually.
  IF NEW.ride_mode <> 'cargo' OR NEW.status <> 'accepted' OR OLD.status = 'accepted' THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RAISE WARNING '[notify_delivery_recipient_on_accept] service_role_key missing — skipping EF call for ride %', NEW.id;
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key
  );

  v_payload := jsonb_build_object('ride_id', NEW.id);

  -- Fire-and-forget. pg_net is async; failures here must NEVER block
  -- the ride from being marked accepted.
  PERFORM net.http_post(
    url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/notify-delivery-recipient',
    headers := v_headers,
    body := v_payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Catch absolutely anything (missing pg_net, network blip, RPC
  -- helper renamed, …) so a notification gap never breaks accept.
  RAISE WARNING '[notify_delivery_recipient_on_accept] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

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

COMMENT ON FUNCTION public.notify_delivery_recipient_on_accept() IS
  '00325 Audit G2 fix: POST to notify-delivery-recipient EF on cargo accept. Idempotent via WHEN clause + downstream claim_delivery_notification atomic claim.';
