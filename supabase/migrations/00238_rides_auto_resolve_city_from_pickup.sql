-- ============================================================
-- rides.city_id: auto-resolve from pickup_location + backfill (Audit Item 3)
-- ============================================================
-- Audit finding: 110/110 rides in prod had city_id = NULL even though
-- pickup_location was populated. The admin /cities page rendered "0
-- viajes" for every Cuban city as a result, and any per-city analytics
-- or dispatch gate that read rides.city_id was effectively blind.
--
-- Root cause: the client `rideService.createRide()` doesn't include
-- city_id in its INSERT (and neither does `create_rides_for_recurring`).
-- The existing trigger `tg_rides_enforce_active_city()` allowed NULL
-- through for backward-compat, so inserts silently produced NULL rows.
--
-- Fix shape:
--   1. Extend the existing trigger to auto-resolve city_id from
--      pickup_location against `cities.bounds_*_lat/lng` when caller
--      didn't provide one. Single source of truth: every insertion
--      path (client SDK, recurring-rides RPC, future flows) is covered.
--   2. Backfill existing rows where the pickup falls inside a known
--      city's bounding box. Rides outside any registered Cuban city
--      (demo mode in São Paulo, dev seed coords, etc.) stay NULL by
--      design — the trigger preserves the legacy backward-compat path.
--
-- Dry-run on prod (before applying):
--   45 rides → La Habana
--    1 ride  → Sancti Spíritus
--   64 rides → outside any city bbox (kept NULL)
--
-- Risk: low. CREATE OR REPLACE FUNCTION preserves the trigger
-- registration (no DROP/CREATE); the active-city enforcement
-- behaviour is preserved bit-for-bit for inputs that already had
-- city_id set. The backfill UPDATE only touches rows where city_id
-- is currently NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_rides_enforce_active_city()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_active BOOLEAN;
  v_resolved_city UUID;
BEGIN
  -- Auto-resolve city_id from pickup_location when caller didn't set it.
  -- Most insertion paths (rideService.createRide, create_rides_for_recurring,
  -- backfills) don't pass city_id — resolve it here so admin /cities,
  -- analytics and per-city dispatch gates are no longer blind.
  IF NEW.city_id IS NULL AND NEW.pickup_location IS NOT NULL THEN
    SELECT id INTO v_resolved_city
    FROM cities
    WHERE ST_Y(NEW.pickup_location::geometry) BETWEEN bounds_sw_lat AND bounds_ne_lat
      AND ST_X(NEW.pickup_location::geometry) BETWEEN bounds_sw_lng AND bounds_ne_lng
    ORDER BY is_active DESC NULLS LAST
    LIMIT 1;
    NEW.city_id := v_resolved_city;
  END IF;

  -- Null city_id: no enforcement (backward compat for legacy/demo rides
  -- whose pickup falls outside any registered Cuban city bbox).
  IF NEW.city_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_active INTO v_active FROM cities WHERE id = NEW.city_id;
  IF v_active IS FALSE THEN
    RAISE EXCEPTION 'city_not_active'
      USING HINT = 'The requested ride city is currently disabled by the operator.';
  END IF;

  RETURN NEW;
END;
$function$;

-- Backfill the resolvable existing rides. Rides whose pickup falls
-- outside any registered Cuban city's bounding box stay NULL.
UPDATE rides r
SET city_id = c.id
FROM cities c
WHERE r.city_id IS NULL
  AND r.pickup_location IS NOT NULL
  AND ST_Y(r.pickup_location::geometry) BETWEEN c.bounds_sw_lat AND c.bounds_ne_lat
  AND ST_X(r.pickup_location::geometry) BETWEEN c.bounds_sw_lng AND c.bounds_ne_lng;

-- Verification (run after applying):
--   SELECT count(*) FILTER (WHERE city_id IS NOT NULL) AS resolved,
--          count(*) FILTER (WHERE city_id IS NULL) AS still_null
--   FROM rides;
--   -- expected: ~46 resolved (existing prod data), ~64 still null
--
--   -- Confirm new inserts get city_id automatically:
--   -- (the audit dry-run showed 45 La Habana + 1 Sancti Spíritus, so
--   --  any new ride with pickup in those bboxes will now get the city
--   --  attribution without the client having to pass it.)
