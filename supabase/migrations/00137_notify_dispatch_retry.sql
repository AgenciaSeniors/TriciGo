-- ============================================================
-- Migration 00137: Notify customer on dispatch retry (N2)
--
-- Migration 00126 added an auto-retry loop (rounds 2 and 3 with
-- expanding radius) when no driver accepts the initial batch of
-- offers. The rider, however, saw nothing — just a prolonged
-- "buscando conductor" spinner. This trigger sends a gentle push
-- each time dispatch escalates, so the rider knows we're still
-- trying and isn't tempted to cancel.
--
-- Fires only when:
--   - status = 'searching' (still matching, no driver yet)
--   - dispatch_round increased from previous value
--   - dispatch_round > 1 (skip the first round, which is instantaneous)
--
-- Silent when vault key is missing — same degradation pattern as
-- migrations 00124, 00134.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_dispatch_retry()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_service_key TEXT;
  v_headers     JSONB;
  v_body        TEXT;
BEGIN
  -- Guard: only notify on escalation rounds during active search.
  IF NEW.status <> 'searching' THEN RETURN NEW; END IF;
  IF NEW.dispatch_round IS NULL OR OLD.dispatch_round IS NULL THEN RETURN NEW; END IF;
  IF NEW.dispatch_round <= OLD.dispatch_round THEN RETURN NEW; END IF;
  IF NEW.dispatch_round < 2 THEN RETURN NEW; END IF;
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;

  v_body := CASE NEW.dispatch_round
    WHEN 2 THEN 'Seguimos buscando un conductor cercano. Gracias por tu paciencia.'
    WHEN 3 THEN 'Ampliamos la búsqueda a más conductores. Pronto te confirmamos.'
    ELSE 'Seguimos buscando conductor.'
  END;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;  -- Skip silently; no vault secret configured.
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
      'data', jsonb_build_object(
        'type',           'ride_matching',
        'ride_id',        NEW.id::text,
        'dispatch_round', NEW.dispatch_round
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- Never block the dispatch retry.
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_dispatch_retry ON rides;
CREATE TRIGGER trg_notify_dispatch_retry
  AFTER UPDATE OF dispatch_round ON rides
  FOR EACH ROW
  WHEN (NEW.dispatch_round > OLD.dispatch_round AND NEW.status = 'searching')
  EXECUTE FUNCTION public.notify_dispatch_retry();

REVOKE EXECUTE ON FUNCTION public.notify_dispatch_retry() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.notify_dispatch_retry() IS
  'N2 ride-flow review: pushes a reassurance message to the rider when the matcher escalates to round 2 or 3 of the retry loop.';
