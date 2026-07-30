# Driver Network Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every ride request reaches every eligible driver — unlimited dispatch radius, offer-to-all, re-offers for ignored offers, reactivation push to offline drivers, 10-minute passenger wait window.

**Architecture:** One SQL migration (00524) rewrites the four dispatch functions from their LIVE prod bodies (captured via `pg_get_functiondef` on 2026-07-30) with config-driven radius/limit/heartbeat, converts the offer INSERT into a re-arming upsert, and adds a reactivation-push function that runs inside the existing 1-minute retry cron. A small admin change exposes the 8 new `platform_config` keys. **No mobile app changes; no Edge Function changes** (send-push already accepts `user_ids[]`).

**Tech Stack:** Postgres/plpgsql (Supabase), `net.http_post` → EF `send-push` (vault pattern), Next.js admin, i18n es/en/pt.

**Spec:** `docs/superpowers/specs/2026-07-30-driver-network-expansion-design.md`

**Context you must know (verified against prod 2026-07-30):**
- Latest migration on origin/master: `00523`. No open PR touches migrations → this PR uses **00524**.
- Live function bodies were fetched with `pg_get_functiondef` this session; the migration below embeds them with surgical edits. Do NOT rebuild them from old migration files (00432-lesson: git ≠ prod).
- `ride_offers` has `UNIQUE (ride_id, driver_profile_id)`; status check allows `pending|accepted|rejected|expired|superseded`. Triggers: `ride_offers_increment_offered` (AFTER INSERT), `ride_offers_refresh_acceptance` (AFTER UPDATE OF status), `trg_notify_driver_new_offer` (AFTER INSERT).
- `send-push` EF accepts `user_ids: string[]` and writes `notifications.type = category`. Category **`ride_matching`** is whitelisted in `notifications_type_check` and maps to the `ride_updates` notification preference (work-related, not promotions).
- The driver APK ignores realtime UPDATEs that stay `pending`, but its 30s poll fallback (`getSearchingRides` → `addRequest`) renders re-armed offers, and `removeStaleRequests` honors server `offer_expires_at` → TTL 45s needs no app change.
- MCP guard: `apply_migration` needs explicit per-apply user authorization via AskUserQuestion AFTER the PR merge. Merges to master need explicit per-PR "OK".
- `platform_config.value` is **jsonb** — booleans must be read tolerating both `true` and `"true"` forms (`value #>> '{}'`).

---

## Task 1: Migration 00524

**Files:**
- Create: `supabase/migrations/00524_driver_network_expansion.sql`

There is no local Postgres stack — SQL is verified against prod after apply (Task 5), per the repo's documented DB-only pattern. The "test" for this task is a careful self-diff against the live bodies captured in the session transcript.

- [ ] **Step 1: Write the migration file**

Write `supabase/migrations/00524_driver_network_expansion.sql` with EXACTLY this content:

```sql
-- 00524_driver_network_expansion.sql
--
-- Driver network expansion (spec: docs/superpowers/specs/2026-07-30-driver-network-expansion-design.md)
--
-- Problem: with ~6 online drivers (all Havana) the 5→7.5→10 km radius ladder +
-- top-10 limit + 3-min heartbeat filter + one-offer-per-driver-per-ride meant
-- ~half of all rides in the last 30 days died with ZERO offers created.
--
-- Changes (all config-driven, admin-tunable, zero app changes):
--   A. platform_config keys: dispatch_max_radius_m=0 (unlimited), dispatch_offer_limit=0
--      (offer to all), dispatch_heartbeat_window_s=0 (no freshness filter — consciously
--      relaxes the R5 hardening; >0 restores it), reoffer_cooldown_s=120,
--      searching_abandon_seconds=600, reactivation_push_after_s=60,
--      reactivation_push_cooldown_s=1800, reactivation_push_enabled=true;
--      offer_ttl_seconds 30→45 (only if still at the default).
--   B. find_best_drivers: radius<=0 = unbounded; heartbeat window from config;
--      distance score normalized to GREATEST(radius,10km); p_limit<=0 = no LIMIT.
--   C. dispatch_ride: radius/limit resolved from config (the p_radius_m parameter is
--      kept for caller compatibility but no longer drives the search); the offer INSERT
--      re-arms EXPIRED offers past the cooldown (rejected/accepted/superseded untouched).
--   D. trg_notify_driver_reoffer: AFTER UPDATE expired→pending re-uses
--      notify_driver_new_offer() so re-armed offers push again.
--   E. retry_dispatch_expired_rides: ladder removed; calls the reactivation push.
--   F. notify_offline_drivers_for_searching_rides(): push (category ride_matching,
--      via send-push user_ids batch) to approved+offline drivers of the requested
--      vehicle type, 30-min per-driver cooldown in driver_reactivation_pushes.
--   G. dispatch_searching_rides_for_driver: 15 km scan / 10 km dispatch caps lifted.
--
-- Function bodies below were transcribed from LIVE prod (pg_get_functiondef,
-- 2026-07-30) with surgical edits — NOT rebuilt from older migration files.

-- ============================================================
-- A. Config keys
-- ============================================================
INSERT INTO platform_config (key, value) VALUES
  ('dispatch_max_radius_m',        '0'::jsonb),
  ('dispatch_offer_limit',         '0'::jsonb),
  ('dispatch_heartbeat_window_s',  '0'::jsonb),
  ('reoffer_cooldown_s',           '120'::jsonb),
  ('searching_abandon_seconds',    '600'::jsonb),
  ('reactivation_push_after_s',    '60'::jsonb),
  ('reactivation_push_cooldown_s', '1800'::jsonb),
  ('reactivation_push_enabled',    'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Offer TTL 30s → 45s, but only if the admin hasn't already tuned it away
-- from the default (idempotent + respects manual overrides).
UPDATE platform_config
SET value = '45'::jsonb
WHERE key = 'offer_ttl_seconds'
  AND (value #>> '{}') = '30';

-- ============================================================
-- Anti-spam ledger for reactivation pushes. Separate table (NOT a
-- driver_profiles column) so the *_protect_admin_fields trigger family
-- never sees these writes. Service-role only: RLS on, no policies
-- (documented lock-table pattern; expected rls_enabled_no_policy advisor).
-- ============================================================
CREATE TABLE IF NOT EXISTS driver_reactivation_pushes (
  driver_profile_id UUID PRIMARY KEY REFERENCES driver_profiles(id) ON DELETE CASCADE,
  last_pushed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE driver_reactivation_pushes ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- B. find_best_drivers — live body + 4 surgical edits:
--    (1) DECLARE v_hb_window_s + read config
--    (2) heartbeat filter gated by v_hb_window_s (0 = off; NULL heartbeat always passes)
--    (3) ST_DWithin skipped when p_radius_m <= 0
--    (4) distance normalization GREATEST(p_radius_m, 10000); LIMIT NULL when p_limit <= 0
-- ============================================================
CREATE OR REPLACE FUNCTION public.find_best_drivers(
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_service_type text,
  p_limit integer DEFAULT 5,
  p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false,
  p_estimated_trip_distance_m integer DEFAULT NULL::integer,
  p_package_category text DEFAULT NULL::text,
  p_estimated_weight_kg numeric DEFAULT NULL::numeric,
  p_package_length_cm integer DEFAULT NULL::integer,
  p_package_width_cm integer DEFAULT NULL::integer,
  p_package_height_cm integer DEFAULT NULL::integer,
  p_corporate_account_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, user_id uuid, distance_m double precision, match_score numeric, rating numeric, acceptance_rate numeric, composite double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_types vehicle_type[];
  v_is_long_trip BOOLEAN;
  v_use_fleet_restriction BOOLEAN := false;
  v_hb_window_s NUMERIC;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  -- 00524: heartbeat freshness window from config. 0 (default) = no filter —
  -- with offers going to ALL candidates in parallel, a stale-GPS driver blocks
  -- nobody (the offer just expires). Setting N>0 restores the R5 hardening.
  v_hb_window_s := get_platform_config_numeric('dispatch_heartbeat_window_s', 0);

  v_vehicle_types := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::vehicle_type]
  END;

  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  IF p_corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = p_corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_use_fleet_restriction;
  END IF;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id              AS dp_id,
      dp.user_id         AS dp_user_id,
      dp.match_score     AS dp_match_score,
      dp.rating_avg      AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
        FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status = 'completed'
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND r.accepted_at IS NOT NULL
      )::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id
    WHERE dp.is_online = true
      AND (
        v_hb_window_s <= 0
        OR dp.last_heartbeat_at IS NULL
        OR dp.last_heartbeat_at > now() - make_interval(secs => v_hb_window_s)
      )
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND (
        p_package_category IS NULL
        OR (
          v.accepted_cargo_categories IS NOT NULL
          AND array_length(v.accepted_cargo_categories, 1) > 0
          AND p_package_category = ANY(v.accepted_cargo_categories::text[])
        )
      )
      AND (
        p_estimated_weight_kg IS NULL
        OR (v.max_cargo_weight_kg IS NOT NULL AND v.max_cargo_weight_kg >= p_estimated_weight_kg)
      )
      AND (
        p_package_length_cm IS NULL
        OR (v.max_cargo_length_cm IS NOT NULL AND v.max_cargo_length_cm >= p_package_length_cm)
      )
      AND (
        p_package_width_cm IS NULL
        OR (v.max_cargo_width_cm IS NOT NULL AND v.max_cargo_width_cm >= p_package_width_cm)
      )
      AND (
        p_package_height_cm IS NULL
        OR (v.max_cargo_height_cm IS NOT NULL AND v.max_cargo_height_cm >= p_package_height_cm)
      )
      AND (p_radius_m <= 0 OR ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m))
      AND (c.id IS NULL OR c.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
      AND (
        NOT v_use_fleet_restriction
        OR EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = p_corporate_account_id
            AND fm.driver_id = dp.user_id
            AND fm.status = 'active'
        )
      )
  )
  SELECT
    ed.dp_id, ed.dp_user_id, ed.dist_m,
    ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (
      0.30 * (1.0 - LEAST(ed.dist_m / GREATEST(p_radius_m, 10000)::DOUBLE PRECISION, 1.0)) +
      0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
      0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
      0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
      0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
      0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT (CASE WHEN p_limit > 0 THEN p_limit END);
END;
$function$;

-- ============================================================
-- C. dispatch_ride — live body + edits:
--    (1) effective radius/limit resolved from config (p_radius_m no longer
--        drives the search; kept for trigger/cron caller compatibility)
--    (2) low-rating gate keeps its own limit/radius (no LEAST against
--        "unlimited")
--    (3) ON CONFLICT re-arms EXPIRED offers past reoffer_cooldown_s
-- ============================================================
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride         rides%ROWTYPE;
  v_pickup_lat   double precision;
  v_pickup_lng   double precision;
  v_is_delivery  boolean;
  v_count        int := 0;
  v_round        int;
  v_offer_ttl_s  int;
  v_rider_rating numeric;
  v_threshold    numeric;
  v_limit        int;
  v_eff_radius   int;
  v_gated        boolean := false;
  v_reoffer_cooldown_s int;
BEGIN
  IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria');

  -- 00512: a cargo ride is INSERTed before its delivery_details row exists, and
  -- this runs inside the ride's own INSERT trigger. Dispatching now would mean
  -- dispatching without the package specs. Defer; trg_dispatch_on_delivery_details
  -- re-dispatches as soon as the specs land.
  IF v_is_delivery AND NOT EXISTS (
    SELECT 1 FROM delivery_details dd WHERE dd.ride_id = p_ride_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'offers_created', 0,
                              'dispatch_round', v_ride.dispatch_round,
                              'deferred', 'awaiting_delivery_details');
  END IF;
  v_round := v_ride.dispatch_round + 1;

  -- 00524: radius and candidate limit come from config, not from the caller.
  -- 0 = unlimited/all (the low-supply default). The p_radius_m parameter is
  -- retained only so existing callers (insert trigger, retry cron, driver-online
  -- dispatcher) keep compiling.
  v_eff_radius := GREATEST(0, get_platform_config_numeric('dispatch_max_radius_m', 0))::int;
  v_limit      := GREATEST(0, get_platform_config_numeric('dispatch_offer_limit', 0))::int;
  v_reoffer_cooldown_s := GREATEST(0, get_platform_config_numeric('reoffer_cooldown_s', 120))::int;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  -- Soft low-rating rider gate (first round only)
  v_threshold := get_platform_config_numeric('low_rating_rider_threshold', 3.0);
  IF v_round = 1 AND v_threshold > 0 THEN
    SELECT cp.rating_avg INTO v_rider_rating
      FROM customer_profiles cp WHERE cp.user_id = v_ride.customer_id;
    IF v_rider_rating IS NOT NULL AND v_rider_rating < v_threshold THEN
      v_gated := true;
      v_limit := GREATEST(1, get_platform_config_numeric('low_rating_rider_dispatch_limit', 5)::int);
      v_eff_radius := GREATEST(500, get_platform_config_numeric('low_rating_rider_radius_m', 3000)::int);
    END IF;
  END IF;

  -- 00524: EXPIRED offers past the cooldown re-arm (status back to 'pending',
  -- fresh TTL) so a distracted driver rings again while the ride keeps
  -- searching. Rejected/accepted/superseded offers are never touched.
  -- trg_notify_driver_reoffer (below) re-fires the push for re-arms.
  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    v_limit,
    v_eff_radius,
    v_is_delivery,
    v_ride.estimated_distance_m,
    (SELECT dd.package_category  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.estimated_weight_kg FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_length_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_width_cm  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_height_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    v_ride.corporate_account_id
  ) fbd
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = v_ride.customer_id AND ub.blocked_id = fbd.user_id)
       OR (ub.blocker_id = fbd.user_id AND ub.blocked_id = v_ride.customer_id)
  )
  ON CONFLICT (ride_id, driver_profile_id) DO UPDATE
    SET status          = 'pending',
        expires_at      = EXCLUDED.expires_at,
        composite_score = EXCLUDED.composite_score,
        distance_m      = EXCLUDED.distance_m,
        responded_at    = NULL
    WHERE ride_offers.status = 'expired'
      AND ride_offers.expires_at < now() - make_interval(secs => v_reoffer_cooldown_s);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s,
                            'low_rating_gated', v_gated);
END;
$function$;

-- ============================================================
-- D. Re-offer push: re-arming an expired offer must ring the driver again.
-- notify_driver_new_offer() only reads NEW.* so it works for UPDATE rows too.
-- ============================================================
DROP TRIGGER IF EXISTS trg_notify_driver_reoffer ON ride_offers;
CREATE TRIGGER trg_notify_driver_reoffer
  AFTER UPDATE OF status ON ride_offers
  FOR EACH ROW
  WHEN (OLD.status = 'expired' AND NEW.status = 'pending')
  EXECUTE FUNCTION notify_driver_new_offer();

-- ============================================================
-- F. Reactivation push to offline approved drivers (runs from the retry cron).
-- ============================================================
CREATE OR REPLACE FUNCTION public.notify_offline_drivers_for_searching_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled      TEXT;
  v_after_s      INT;
  v_cooldown_s   INT;
  v_service_key  TEXT;
  v_headers      JSONB;
  v_group        RECORD;
  v_user_ids     JSONB;
  v_dp_ids       UUID[];
  v_total        INT := 0;
  v_title        TEXT;
  v_body         TEXT;
BEGIN
  -- Kill switch. jsonb value read via #>> '{}' matches both boolean false and
  -- string "false" (platform_config jsonb trap).
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'reactivation_push_enabled';
  IF v_enabled IN ('false', 'f') THEN RETURN 0; END IF;

  v_after_s    := GREATEST(0, get_platform_config_numeric('reactivation_push_after_s', 60))::int;
  v_cooldown_s := GREATEST(60, get_platform_config_numeric('reactivation_push_cooldown_s', 1800))::int;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN 0; END IF;
  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  -- One push batch per vehicle-type label so the copy can name the service.
  -- Stamping the cooldown between groups dedupes drivers who match several
  -- searching rides of different types.
  FOR v_group IN
    SELECT
      CASE
        WHEN r.service_type LIKE 'triciclo%' THEN 'triciclo'
        WHEN r.service_type LIKE 'moto%'     THEN 'moto'
        WHEN r.service_type LIKE 'auto%'     THEN 'auto'
        WHEN r.service_type = 'mensajeria'   THEN 'mensajeria'
        ELSE 'triciclo'
      END AS label
    FROM rides r
    WHERE r.status = 'searching'
      AND r.created_at <= now() - make_interval(secs => v_after_s)
      AND NOT (COALESCE(r.is_scheduled, false) AND r.scheduled_at IS NOT NULL AND r.scheduled_at > now())
    GROUP BY 1
  LOOP
    -- Candidates: approved + OFFLINE, financially eligible, active vehicle of
    -- the requested type (auto covers confort; mensajería = any cargo vehicle),
    -- not blocked either way with ANY searching customer of this group, and
    -- outside their reactivation cooldown. No geographic filter — the user's
    -- explicit choice while the whole fleet is in Havana (conscious debt:
    -- add a radius when multi-province supply exists).
    SELECT array_agg(DISTINCT dp.id), jsonb_agg(DISTINCT dp.user_id)
      INTO v_dp_ids, v_user_ids
    FROM driver_profiles dp
    JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    WHERE dp.status = 'approved'
      AND dp.is_online = false
      AND dp.is_financially_eligible = true
      AND dp.match_score > 10
      AND (
        (v_group.label = 'triciclo'   AND v.type = 'triciclo')
        OR (v_group.label = 'moto'    AND v.type = 'moto')
        OR (v_group.label = 'auto'    AND v.type IN ('auto', 'confort'))
        OR (v_group.label = 'mensajeria' AND v.accepts_cargo = true)
      )
      AND NOT EXISTS (
        SELECT 1 FROM driver_reactivation_pushes p
        WHERE p.driver_profile_id = dp.id
          AND p.last_pushed_at > now() - make_interval(secs => v_cooldown_s)
      )
      AND EXISTS (
        SELECT 1 FROM rides r2
        WHERE r2.status = 'searching'
          AND r2.created_at <= now() - make_interval(secs => v_after_s)
          AND NOT (COALESCE(r2.is_scheduled, false) AND r2.scheduled_at IS NOT NULL AND r2.scheduled_at > now())
          AND (CASE
                 WHEN r2.service_type LIKE 'triciclo%' THEN 'triciclo'
                 WHEN r2.service_type LIKE 'moto%'     THEN 'moto'
                 WHEN r2.service_type LIKE 'auto%'     THEN 'auto'
                 WHEN r2.service_type = 'mensajeria'   THEN 'mensajeria'
                 ELSE 'triciclo'
               END) = v_group.label
          AND NOT EXISTS (
            SELECT 1 FROM public.user_blocks ub
            WHERE (ub.blocker_id = r2.customer_id AND ub.blocked_id = dp.user_id)
               OR (ub.blocker_id = dp.user_id AND ub.blocked_id = r2.customer_id)
          )
      );

    IF v_dp_ids IS NULL OR array_length(v_dp_ids, 1) IS NULL THEN
      CONTINUE;
    END IF;

    IF v_group.label = 'mensajeria' THEN
      v_title := '📦 Hay una entrega esperando conductor';
      v_body  := 'Conéctate en TriciGo para tomar la entrega.';
    ELSE
      v_title := '🚕 Un pasajero está buscando ' || v_group.label;
      v_body  := 'Conéctate en TriciGo para tomar el viaje.';
    END IF;

    BEGIN
      PERFORM net.http_post(
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := v_headers,
        body    := jsonb_build_object(
          'user_ids', v_user_ids,
          'title',    v_title,
          'body',     v_body,
          'category', 'ride_matching',
          'data', jsonb_build_object('reason', 'driver_reactivation')
        )
      );

      INSERT INTO driver_reactivation_pushes (driver_profile_id, last_pushed_at)
      SELECT unnest(v_dp_ids), now()
      ON CONFLICT (driver_profile_id) DO UPDATE SET last_pushed_at = now();

      v_total := v_total + COALESCE(array_length(v_dp_ids, 1), 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[reactivation_push] group % failed: % %', v_group.label, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN v_total;
END;
$function$;

-- ============================================================
-- E. retry_dispatch_expired_rides — ladder removed (config drives the radius
-- inside dispatch_ride now) + reactivation push hook.
-- ============================================================
CREATE OR REPLACE FUNCTION public.retry_dispatch_expired_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_processed   int := 0;
BEGIN
  FOR r IN
    SELECT id, dispatch_round
    FROM rides
    WHERE status = 'searching'
      AND (dispatch_round >= 1 OR ride_mode = 'cargo')
      AND COALESCE(last_dispatched_at, created_at) < now() - interval '30 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM ride_offers o
        WHERE o.ride_id = rides.id
          AND o.status = 'pending'
          AND o.expires_at > now()
      )
  LOOP
    -- 00524: no radius ladder — dispatch_ride resolves radius/limit from
    -- platform_config (default: unlimited / all eligible drivers).
    PERFORM dispatch_ride(r.id);
    v_processed := v_processed + 1;
  END LOOP;

  -- 00524: nudge the dormant offline network. Own exception guard — a push
  -- problem must never break the dispatch retry loop.
  BEGIN
    PERFORM notify_offline_drivers_for_searching_rides();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[retry_dispatch] reactivation push failed: % %', SQLSTATE, SQLERRM;
  END;

  RETURN v_processed;
END;
$function$;

-- ============================================================
-- G. dispatch_searching_rides_for_driver — the hidden 15 km ride-scan and
-- 10 km dispatch caps defeated the reactivation loop (push → driver connects
-- → trigger must offer them the ride even if it's across town).
-- ============================================================
CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_for_driver(p_driver_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r     record;
  v_loc geography;
  v_max_radius_m int;
BEGIN
  SELECT current_location INTO v_loc
  FROM driver_profiles
  WHERE id = p_driver_profile_id;

  IF v_loc IS NULL THEN RETURN; END IF;

  -- 00524: same config as dispatch_ride. 0 = no distance cap.
  v_max_radius_m := GREATEST(0, get_platform_config_numeric('dispatch_max_radius_m', 0))::int;

  FOR r IN
    SELECT id FROM rides
    WHERE status = 'searching'
      AND pickup_location IS NOT NULL
      AND (v_max_radius_m <= 0 OR ST_DWithin(pickup_location, v_loc, v_max_radius_m))
  LOOP
    PERFORM dispatch_ride(r.id);
  END LOOP;
END;
$function$;
```

- [ ] **Step 2: Fidelity self-check against the live bodies**

Compare the unchanged regions of `find_best_drivers` and `dispatch_ride` in the file you just wrote against the live bodies captured in the session transcript (the two `pg_get_functiondef` outputs). Every filter (cargo dims, preferences, fleet restriction, city active, one-active-ride, user_blocks, low-rating gate, 00512 cargo deferral) must be present and byte-equivalent except the seven documented edits:

1. `find_best_drivers`: new `v_hb_window_s` DECLARE + config read; heartbeat filter parametrized; `ST_DWithin` behind `p_radius_m <= 0 OR`; distance normalization `GREATEST(p_radius_m, 10000)`; `LIMIT (CASE WHEN p_limit > 0 THEN p_limit END)`.
2. `dispatch_ride`: new DECLAREs; `v_eff_radius`/`v_limit`/`v_reoffer_cooldown_s` from config (ladder param ignored); gated branch uses `GREATEST` not `LEAST`; `ON CONFLICT … DO UPDATE … WHERE status='expired' AND expires_at < now() - cooldown`.

Expected: no other differences. If any filter went missing, fix before committing.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00524_driver_network_expansion.sql
git commit -m "feat(dispatch): unlimited-radius offer-to-all matching + re-offers + offline reactivation push

Half of all rides in the last 30 days died with zero offers: 10 km radius
ceiling, top-10 limit, 3-min heartbeat filter, and one-offer-per-driver-
per-ride starved a 6-driver network. All knobs move to platform_config
(defaults: unlimited radius, offer to all, no heartbeat filter), expired
offers re-arm every ~2 min (rejected never), and approved-but-offline
drivers get a reactivation push (30-min cooldown, kill switch).

Migration staged only — applied via authorized MCP after merge.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Admin platform-config metadata

**Files:**
- Modify: `apps/admin/src/app/settings/platform-config/page.tsx` (KNOWN_KEYS record, after the `routing_google_enabled` entry region)
- Modify: `packages/i18n/src/locales/es/admin.json`, `en/admin.json`, `pt/admin.json` (inside the existing `platform_config` object, alongside the other `*_help` keys)

- [ ] **Step 1: Add the 8 KNOWN_KEYS entries**

In `apps/admin/src/app/settings/platform-config/page.tsx`, append to the `KNOWN_KEYS` record (booleans use `type: 'text'` per the page's convention — see `weather_surge_enabled`):

```typescript
  // ── Driver network expansion (00524) — dispatch reach & reactivation ──
  dispatch_max_radius_m: { type: 'number', helpKey: 'platform_config.dispatch_max_radius_m_help' },
  dispatch_offer_limit: { type: 'number', helpKey: 'platform_config.dispatch_offer_limit_help' },
  dispatch_heartbeat_window_s: { type: 'number', helpKey: 'platform_config.dispatch_heartbeat_window_s_help' },
  reoffer_cooldown_s: { type: 'number', helpKey: 'platform_config.reoffer_cooldown_s_help' },
  searching_abandon_seconds: { type: 'number', helpKey: 'platform_config.searching_abandon_seconds_help' },
  reactivation_push_after_s: { type: 'number', helpKey: 'platform_config.reactivation_push_after_s_help' },
  reactivation_push_cooldown_s: { type: 'number', helpKey: 'platform_config.reactivation_push_cooldown_s_help' },
  reactivation_push_enabled: { type: 'text', helpKey: 'platform_config.reactivation_push_enabled_help' },
```

- [ ] **Step 2: Add help texts to the three locales**

`packages/i18n/src/locales/es/admin.json` — inside the `platform_config` object:

```json
    "dispatch_max_radius_m_help": "Radio máximo de búsqueda de conductores en metros. 0 = sin límite (la oferta llega a todos los conductores elegibles sin importar la distancia).",
    "dispatch_offer_limit_help": "Cantidad máxima de conductores que reciben cada oferta por ronda. 0 = todos los elegibles.",
    "dispatch_heartbeat_window_s_help": "Ventana de frescura del GPS del conductor en segundos para recibir ofertas. 0 = sin filtro (conductores online con GPS viejo también reciben ofertas).",
    "reoffer_cooldown_s_help": "Segundos mínimos desde que una oferta expiró para volver a ofrecérsela al mismo conductor. Las ofertas rechazadas explícitamente nunca se repiten.",
    "searching_abandon_seconds_help": "Segundos que una búsqueda sobrevive sin señales del pasajero (app cerrada o en segundo plano) antes de cancelarse sola.",
    "reactivation_push_after_s_help": "Segundos de búsqueda sin aceptación antes de notificar a conductores aprobados desconectados para que se conecten.",
    "reactivation_push_cooldown_s_help": "Segundos mínimos entre notificaciones de reactivación al mismo conductor (anti-spam).",
    "reactivation_push_enabled_help": "true/false — interruptor del aviso a conductores desconectados cuando hay viajes buscando conductor."
```

`packages/i18n/src/locales/en/admin.json`:

```json
    "dispatch_max_radius_m_help": "Maximum driver search radius in meters. 0 = unlimited (the offer reaches every eligible driver regardless of distance).",
    "dispatch_offer_limit_help": "Maximum number of drivers that receive each offer per round. 0 = all eligible drivers.",
    "dispatch_heartbeat_window_s_help": "Driver GPS freshness window in seconds required to receive offers. 0 = no filter (online drivers with stale GPS also receive offers).",
    "reoffer_cooldown_s_help": "Minimum seconds since an offer expired before re-offering to the same driver. Explicitly rejected offers are never repeated.",
    "searching_abandon_seconds_help": "Seconds a search survives without passenger signals (app closed or backgrounded) before auto-canceling.",
    "reactivation_push_after_s_help": "Seconds of unaccepted searching before notifying approved offline drivers to come online.",
    "reactivation_push_cooldown_s_help": "Minimum seconds between reactivation notifications to the same driver (anti-spam).",
    "reactivation_push_enabled_help": "true/false — switch for notifying offline drivers when rides are searching for a driver."
```

`packages/i18n/src/locales/pt/admin.json`:

```json
    "dispatch_max_radius_m_help": "Raio máximo de busca de motoristas em metros. 0 = sem limite (a oferta chega a todos os motoristas elegíveis, independente da distância).",
    "dispatch_offer_limit_help": "Quantidade máxima de motoristas que recebem cada oferta por rodada. 0 = todos os elegíveis.",
    "dispatch_heartbeat_window_s_help": "Janela de frescor do GPS do motorista em segundos para receber ofertas. 0 = sem filtro (motoristas online com GPS antigo também recebem ofertas).",
    "reoffer_cooldown_s_help": "Segundos mínimos desde que uma oferta expirou para oferecê-la novamente ao mesmo motorista. Ofertas rejeitadas explicitamente nunca se repetem.",
    "searching_abandon_seconds_help": "Segundos que uma busca sobrevive sem sinais do passageiro (app fechado ou em segundo plano) antes de cancelar sozinha.",
    "reactivation_push_after_s_help": "Segundos de busca sem aceitação antes de notificar motoristas aprovados desconectados para ficarem online.",
    "reactivation_push_cooldown_s_help": "Segundos mínimos entre notificações de reativação ao mesmo motorista (anti-spam).",
    "reactivation_push_enabled_help": "true/false — interruptor do aviso a motoristas desconectados quando há viagens buscando motorista."
```

Match each file's existing indentation and comma placement (insert before the closing brace of the `platform_config` object, adding a comma to the previous last line).

- [ ] **Step 3: Type-check**

Run: `pnpm check-types` (if `turbo` is missing, run `pnpm install` first — fresh worktree).
Expected: all 4 apps pass.

- [ ] **Step 4: Lockfile hygiene + commit**

```bash
git checkout HEAD -- pnpm-lock.yaml 2>/dev/null || true
git add apps/admin/src/app/settings/platform-config/page.tsx packages/i18n/src/locales/es/admin.json packages/i18n/src/locales/en/admin.json packages/i18n/src/locales/pt/admin.json
git commit -m "feat(admin): expose driver-network-expansion dispatch tunables in platform-config

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: PR

- [ ] **Step 1: Push branch and create PR**

Write the PR body to `.pr-body-temp.md` (Write tool), covering: the data (39/79 rides died offerless), the 6 behavior changes, the config table with defaults, "Migración NO aplicada a prod (MCP guard) — se aplica vía MCP autorizado post-merge", cross-app parity note (server-side only; admin tunables added; no client/driver/web UI change; no new notification type — `ride_matching` already whitelisted), and the verification plan summary. End with the standard Claude Code footer.

```bash
git push -u origin claude/driver-network-expansion-12af82
gh pr create --title "feat(dispatch): driver network expansion — unlimited radius, re-offers, offline reactivation" --body-file .pr-body-temp.md --base master
rm .pr-body-temp.md
```

- [ ] **Step 2: Ask the user for merge authorization (required per-PR)**

Ask: "¿Autorizo el squash-merge de #NNN?" — wait for explicit OK, then:

```bash
gh pr merge <NUM> --squash --delete-branch
```

---

## Task 4: Apply to prod (gated)

- [ ] **Step 1: AskUserQuestion authorization for the MCP apply**

Use the canonical AskUserQuestion pattern ("SÍ — aplica migración 00524 via MCP ahora") — the classifier denies the first apply without it.

- [ ] **Step 2: Re-check migration number, then apply**

```bash
git fetch origin master
git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -3
```
Expected: `00524_driver_network_expansion.sql` is the newest and unique. If another 00524 landed meanwhile, renumber first.

Apply via `mcp__…__apply_migration` with name `driver_network_expansion` and the file's SQL. (MCP registers version by timestamp — verify by object, not number.)

---

## Task 5: Prod verification (all rolled back — zero real pushes)

`net.http_post` enqueues into the transactional `net.http_request_queue`; ROLLBACK cancels the sends (verified pattern). Run each block via `execute_sql`.

- [ ] **Step 1: Objects + config exist**

```sql
SELECT
  (SELECT COUNT(*) FROM platform_config WHERE key IN
    ('dispatch_max_radius_m','dispatch_offer_limit','dispatch_heartbeat_window_s',
     'reoffer_cooldown_s','searching_abandon_seconds','reactivation_push_after_s',
     'reactivation_push_cooldown_s','reactivation_push_enabled')) AS cfg_rows,          -- expect 8
  (SELECT value FROM platform_config WHERE key='offer_ttl_seconds') AS ttl,             -- expect 45
  to_regclass('public.driver_reactivation_pushes') IS NOT NULL AS tbl_ok,               -- expect t
  (SELECT COUNT(*) FROM pg_trigger WHERE tgname='trg_notify_driver_reoffer') AS trg,    -- expect 1
  (SELECT prosrc ILIKE '%dispatch_max_radius_m%' FROM pg_proc WHERE proname='dispatch_ride') AS dr_ok,
  (SELECT prosrc ILIKE '%dispatch_heartbeat_window_s%' FROM pg_proc WHERE proname='find_best_drivers') AS fbd_ok;
```

- [ ] **Step 2: Dispatch reach (rolled back)**

```sql
BEGIN;
INSERT INTO rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_distance_m, estimated_duration_s, passenger_count, ride_mode)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001',
  (SELECT id FROM users WHERE email='eduardodanielperezruiz@gmail.com' LIMIT 1),
  'triciclo_basico', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3666, 23.1357),4326)::geography, 'Capitolio (QA rollback)',
  ST_SetSRID(ST_MakePoint(-82.3999, 23.1420),4326)::geography, 'Playa (QA rollback)',
  4000, 5000, 900, 1, 'passenger');
-- The INSERT trigger ran dispatch synchronously. Compare against eligibility:
SELECT
  (SELECT COUNT(*) FROM ride_offers WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001') AS offers,
  (SELECT COUNT(*) FROM driver_profiles dp JOIN vehicles v ON v.driver_id=dp.id AND v.is_active
    WHERE dp.is_online AND dp.status='approved' AND dp.is_financially_eligible
      AND NOT dp.is_on_break AND dp.match_score>10 AND v.type='triciclo'
      AND dp.current_location IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id=dp.id
        AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress'))) AS eligible,
  (SELECT COUNT(*) FROM ride_offers o JOIN driver_profiles dp ON dp.id=o.driver_profile_id
    WHERE o.ride_id='aaaaaaaa-0000-4000-8000-000000000001'
      AND (dp.last_heartbeat_at IS NULL OR dp.last_heartbeat_at <= now()-interval '3 minutes')) AS stale_hb_included,
  (SELECT MAX(distance_m) FROM ride_offers WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001') AS max_dist_m;
ROLLBACK;
```
Expected: `offers` = `eligible` (both triciclo drivers if online), `stale_hb_included` ≥ 1 when a stale-GPS triciclo driver is online, `max_dist_m` may exceed 10000.

- [ ] **Step 3: Re-offer re-arm (rolled back)**

```sql
BEGIN;
INSERT INTO rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_distance_m, estimated_duration_s, passenger_count, ride_mode)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001',
  (SELECT id FROM users WHERE email='eduardodanielperezruiz@gmail.com' LIMIT 1),
  'triciclo_basico', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3666, 23.1357),4326)::geography, 'Capitolio (QA rollback)',
  ST_SetSRID(ST_MakePoint(-82.3999, 23.1420),4326)::geography, 'Playa (QA rollback)',
  4000, 5000, 900, 1, 'passenger');
-- Simulate: everyone ignored, TTL passed, cooldown passed
UPDATE ride_offers SET status='expired', responded_at=now(),
  expires_at = now() - interval '10 minutes'
WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001';
-- Mark one driver as an explicit decliner — must NOT re-arm
UPDATE ride_offers SET status='rejected'
WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001'
  AND driver_profile_id=(SELECT driver_profile_id FROM ride_offers
    WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001' LIMIT 1);
SELECT dispatch_ride('aaaaaaaa-0000-4000-8000-000000000001');
SELECT status, COUNT(*) FROM ride_offers
WHERE ride_id='aaaaaaaa-0000-4000-8000-000000000001' GROUP BY 1;
ROLLBACK;
```
Expected: the expired rows are back to `pending` with fresh `expires_at`; exactly one row stays `rejected`.

- [ ] **Step 4: Reactivation push + cooldown (rolled back)**

```sql
BEGIN;
INSERT INTO rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_distance_m, estimated_duration_s, passenger_count, ride_mode, created_at)
VALUES ('aaaaaaaa-0000-4000-8000-000000000002',
  (SELECT id FROM users WHERE email='eduardodanielperezruiz@gmail.com' LIMIT 1),
  'triciclo_basico', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3666, 23.1357),4326)::geography, 'Capitolio (QA rollback)',
  ST_SetSRID(ST_MakePoint(-82.3999, 23.1420),4326)::geography, 'Playa (QA rollback)',
  4000, 5000, 900, 1, 'passenger', now() - interval '3 minutes');
SELECT notify_offline_drivers_for_searching_rides() AS pushed_first;   -- expect > 0
SELECT COUNT(*) FROM driver_reactivation_pushes;                        -- expect = pushed_first
SELECT COUNT(*) FROM net.http_request_queue WHERE url LIKE '%send-push%'; -- expect >= 1 queued
SELECT notify_offline_drivers_for_searching_rides() AS pushed_second;  -- expect 0 (cooldown)
ROLLBACK;
```

- [ ] **Step 5: Abandon window**

```sql
SELECT (value #>> '{}') FROM platform_config WHERE key='searching_abandon_seconds'; -- expect 600
```

- [ ] **Step 6: Advisors sanity**

Run `get_advisors` (security) — the only NEW finding should be `rls_enabled_no_policy` on `driver_reactivation_pushes` (documented lock-table pattern).

---

## Task 6: Documentation

- [ ] **Step 1: CLAUDE.md section**

Add a compact section to CLAUDE.md ("Red de búsqueda de conductores — estado canónico") covering: the config keys and their 0-means-unlimited semantics, the re-offer mechanism (rejected never re-arm), the reactivation push (category ride_matching, cooldown table), the rolled-back verification pattern, and the conscious debt (geographic filter for reactivation when multi-province). Commit to the PR branch BEFORE merge (fold into Task 3) or as a follow-up commit if discovered later.

- [ ] **Step 2: Memory file**

Write `~/.claude/projects/C--Users-Eduardo-TriciGo/memory/project_driver_network_expansion.md` (type: project) with the decision summary + config keys + verification results, and add the index line to `MEMORY.md`.
