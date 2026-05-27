-- ============================================================
-- 00327_push_driver_on_new_offer.sql
--
-- Closes the gap where drivers never receive a push notification
-- when `dispatch_ride()` inserts a new row into `ride_offers`.
-- Until now, drivers only learned of new offers via the Realtime
-- WebSocket subscription on `ride_offers` (added by 00120). That
-- works when the driver app is foregrounded, but a closed /
-- background / network-blip app silently loses the offer — driver
-- stays "online" yet never sees the work.
--
-- Fix: AFTER INSERT trigger on ride_offers that POSTs to send-push
-- EF with a fresh `type='ride_offer'` payload. Pattern mirrors
-- 00325 (`notify_delivery_recipient_on_accept`) and 00269
-- (`notify_dispatch_retry`):
--   - Vault-based service role key (via `get_service_role_key()`).
--   - Fire-and-forget pg_net call. Network blip never aborts the
--     INSERT — the offer itself is the source of truth.
--   - `EXCEPTION WHEN OTHERS THEN RETURN NEW` so a notification
--     hiccup never breaks dispatch.
--
-- Recipient: driver behind `driver_profile_id`.
-- Payload   : type='ride_offer', ride_id, offer_id, expires_at.
-- The driver app already has Realtime + a notification handler
-- (apps/driver/src/hooks/useNotifications.ts) that maps
-- `data.type` to navigation; this PR also adds the `ride_offer`
-- case there.
--
-- Idempotency: ride_offers has UNIQUE(ride_id, driver_profile_id)
-- so duplicate INSERTs are impossible. Each push corresponds 1:1
-- with an offer row. Re-dispatch from the 1-min retry cron will
-- produce a NEW offer row (after the old expired) and a NEW push,
-- which is the desired behavior.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_driver_new_offer()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_catalog'
AS $$
DECLARE
  v_driver_user_id UUID;
  v_ride           rides%ROWTYPE;
  v_service_key    TEXT;
  v_headers        JSONB;
  v_distance_km    NUMERIC;
  v_pickup_short   TEXT;
  v_title          TEXT;
  v_body           TEXT;
  v_fare_label     TEXT;
BEGIN
  -- Resolve driver.user_id (push target). Skip silently if the
  -- driver_profile row vanished between INSERT and trigger fire
  -- (shouldn't happen with FK ON DELETE CASCADE, but defensive).
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles
  WHERE id = NEW.driver_profile_id;

  IF v_driver_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Load the ride. If the ride was canceled between dispatch and
  -- trigger fire, still send — the offer is still valid until
  -- expires_at and the app handles "ride no longer available".
  SELECT * INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Compose copy. Title is fixed; body summarizes pickup + payout
  -- so the driver can decide whether to open the app immediately.
  v_distance_km := ROUND(COALESCE(NEW.distance_m, 0)::numeric / 1000.0, 1);

  -- Truncate pickup address to keep the body inside platform
  -- truncation thresholds (Expo recommends <100 chars for body).
  v_pickup_short := LEFT(COALESCE(v_ride.pickup_address, ''), 50);
  IF LENGTH(COALESCE(v_ride.pickup_address, '')) > 50 THEN
    v_pickup_short := v_pickup_short || '…';
  END IF;

  v_fare_label := COALESCE(v_ride.estimated_fare_cup, 0)::TEXT || ' CUP';

  v_title := 'Viaje disponible cerca';
  v_body  := 'Recogida: ' || v_pickup_short || ' · ' || v_distance_km || ' km · ' || v_fare_label;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    -- Vault secret not configured; skip silently (same pattern as
    -- 00124, 00134, 00269, 00325). Realtime subscription remains
    -- the fallback path.
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
      'user_id',  v_driver_user_id::text,
      'title',    v_title,
      'body',     v_body,
      'category', 'ride_offer',
      'data', jsonb_build_object(
        'type',       'ride_offer',
        'ride_id',    NEW.ride_id::text,
        'offer_id',   NEW.id::text,
        'expires_at', NEW.expires_at,
        'service_type', v_ride.service_type
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Catch absolutely anything (pg_net missing, vault helper renamed,
  -- network blip, …). A notification gap must NEVER abort the
  -- offer INSERT — the offer is the source of truth and Realtime
  -- subscription is the fallback path.
  RAISE WARNING '[notify_driver_new_offer] exception for offer %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_driver_new_offer ON public.ride_offers;

CREATE TRIGGER trg_notify_driver_new_offer
AFTER INSERT ON public.ride_offers
FOR EACH ROW
EXECUTE FUNCTION public.notify_driver_new_offer();

REVOKE EXECUTE ON FUNCTION public.notify_driver_new_offer() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.notify_driver_new_offer() IS
  '00327: Push notification to driver on every new ride_offers row. Realtime subscription is the fallback path; this guarantees delivery when the app is closed/backgrounded.';
