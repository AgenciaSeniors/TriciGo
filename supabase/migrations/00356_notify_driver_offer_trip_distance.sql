-- ============================================================
-- 00356_notify_driver_offer_trip_distance.sql
--
-- Fixes the "0.0 km" shown in the driver's "Viaje disponible
-- cerca" push. The previous body (00332) showed the
-- driver→pickup distance (ride_offers.distance_m = ST_Distance(
-- driver_profiles.current_location, pickup)). That value is ~0
-- whenever the driver's last-known location coincides with the
-- pickup — the norm in self-testing (same person is driver +
-- rider from one spot) and unreliable for a CLOSED app whose
-- current_location is stale. Prod sample 2026-05-30: 34/86 offers
-- had distance_m exactly 0, 26 more under 50 m → ~70% rendered
-- "0.0 km".
--
-- Fix: show the TRIP distance (rides.estimated_distance_m), which
-- is always populated and meaningful (12040 m, 2090 m, …). Body
-- becomes "Recogida: {addr} · Viaje {km} km · {fare} CUP".
--
-- Everything else is copied verbatim from 00332 (the live version,
-- confirmed via pg_get_functiondef). ride_offers.distance_m stays
-- untouched — still used by matching/scoring; we just stop
-- surfacing it in the push copy. Trigger signature unchanged, so
-- the existing trg_notify_driver_new_offer keeps pointing here.
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
  v_trip_km        NUMERIC;
  v_pickup_short   TEXT;
  v_title          TEXT;
  v_body           TEXT;
  v_fare_label     TEXT;
BEGIN
  -- Resolve driver.user_id (push target). Skip silently if the
  -- driver_profile row vanished between INSERT and trigger fire.
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles
  WHERE id = NEW.driver_profile_id;

  IF v_driver_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Load the ride. If canceled between dispatch and trigger fire,
  -- still send — the offer is valid until expires_at and the app
  -- handles "ride no longer available".
  SELECT * INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Trip distance (pickup → dropoff), not driver→pickup. Always
  -- populated for a real ride; never the misleading "0.0 km" that
  -- driver→pickup produced when the driver location coincided with
  -- the pickup (see header).
  v_trip_km := ROUND(COALESCE(v_ride.estimated_distance_m, 0)::numeric / 1000.0, 1);

  -- Truncate pickup address to keep the body inside platform
  -- truncation thresholds (Expo recommends <100 chars for body).
  v_pickup_short := LEFT(COALESCE(v_ride.pickup_address, ''), 50);
  IF LENGTH(COALESCE(v_ride.pickup_address, '')) > 50 THEN
    v_pickup_short := v_pickup_short || '…';
  END IF;

  v_fare_label := COALESCE(v_ride.estimated_fare_cup, 0)::TEXT || ' CUP';

  v_title := 'Viaje disponible cerca';
  v_body  := 'Recogida: ' || v_pickup_short
    || CASE WHEN v_trip_km > 0 THEN ' · Viaje ' || v_trip_km || ' km' ELSE '' END
    || ' · ' || v_fare_label;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    -- Vault secret not configured; skip silently. Realtime
    -- subscription remains the fallback path.
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
  -- A notification gap must NEVER abort the offer INSERT — the
  -- offer is the source of truth and Realtime is the fallback.
  RAISE WARNING '[notify_driver_new_offer] exception for offer %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- Idempotent re-assert of the lockdown (CREATE OR REPLACE keeps the
-- existing trigger binding + grants; this is defensive in case prod
-- grants drifted).
REVOKE EXECUTE ON FUNCTION public.notify_driver_new_offer() FROM PUBLIC, authenticated, anon;

COMMENT ON FUNCTION public.notify_driver_new_offer() IS
  '00356: driver new-offer push now shows TRIP distance (rides.estimated_distance_m) instead of driver→pickup (ride_offers.distance_m), which rendered "0.0 km" when the driver location coincided with the pickup. Body: "Recogida: {addr} · Viaje {km} km · {fare} CUP". Supersedes 00332.';
