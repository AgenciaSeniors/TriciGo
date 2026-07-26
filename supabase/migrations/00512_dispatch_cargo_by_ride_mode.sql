-- 00512: Package offers go to drivers who do not carry packages.
--
-- THE BUG
-- dispatch_ride decides whether a ride is a delivery like this:
--
--     v_is_delivery := (v_ride.service_type = 'mensajeria');
--
-- No ride is ever stored with that service_type. A cargo ride is stored with the
-- slug of the chosen VEHICLE (moto_standard / triciclo_basico / auto_standard /
-- auto_confort) plus ride_mode='cargo' — 'mensajeria' is a client-side
-- pseudo-slug used only for pricing (packages/utils/src/delivery.ts,
-- VEHICLE_TO_SLUG). Verified against production: zero rides carry
-- service_type='mensajeria', and the one cargo ride that ever existed is stored
-- as moto_standard + ride_mode='cargo'.
--
-- So v_is_delivery is permanently false, and every cargo filter 00326 added to
-- find_best_drivers is dead code:
--   * `AND (NOT p_is_delivery OR v.accepts_cargo = true)` never restricts, so
--     package offers reach drivers who explicitly opted out of carrying cargo;
--   * the weight / dimension / category filters are handed NULL by dispatch_ride
--     (five literal NULLs in the call), so a 40 kg load can be offered to a
--     motorcycle.
--
-- THE RACE, AND WHY WE DEFER RATHER THAN GUESS
-- on_ride_insert_dispatch fires AFTER INSERT ON rides and calls dispatch_ride
-- inside that same transaction. delivery_details is written afterwards, by a
-- separate client statement. Round 1 therefore CANNOT see the package specs.
--
-- Dispatching anyway with NULL specs is precisely the bug above, and it would do
-- it on the round with the highest acceptance probability — and an accepted
-- offer cannot be revoked. So a cargo ride with no delivery_details yet is not
-- dispatched at all; the AFTER INSERT trigger on delivery_details re-dispatches
-- within milliseconds.
--
-- Three independent safety nets pick up a deferred ride:
--   1. trg_dispatch_on_delivery_details  — the happy path (milliseconds);
--   2. retry_dispatch_expired_rides      — the cron (≤60s), patched below
--                                          because it skipped dispatch_round=0;
--   3. dispatch_searching_rides_for_driver (00388) — whenever any driver comes
--      online or frees up; it already ignores dispatch_round.
--
-- DELIBERATE CONSEQUENCE: a cargo ride whose delivery_details never arrive is
-- never dispatched (fails closed) and expires via the stale-ride watchdog. That
-- is strictly better than today, where such a ride IS dispatched, can be
-- accepted, and then can never be completed — trg_rides_require_delivery_proof
-- (00438) blocks completion forever because there is no row to carry the OTP and
-- photo. Only an admin could unstick it.
--
-- Patched in place rather than rewritten verbatim: parallel sessions touch
-- dispatch_ride, and a string substitution preserves any concurrent change
-- instead of clobbering it with a snapshot.

-- ── A + B: dispatch_ride ─────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_src     TEXT;
  v_anchor  TEXT;
  v_replace TEXT;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_ride(uuid,integer)'::regprocedure) INTO v_src;

  IF position('awaiting_delivery_details' IN v_src) > 0 THEN
    RAISE NOTICE '00512: dispatch_ride already patched — skipping';
    RETURN;
  END IF;

  -- (A) Derive cargo from ride_mode, and defer while the specs are missing.
  -- rides.ride_mode is NOT NULL DEFAULT 'passenger' (verified), so this
  -- comparison cannot go NULL and drag the filter into three-valued logic.
  v_anchor := $a$v_is_delivery := (v_ride.service_type = 'mensajeria');$a$;

  IF position(v_anchor IN v_src) = 0 THEN
    RAISE EXCEPTION '00512: anchor A not found in dispatch_ride — refusing to apply a silent no-op';
  END IF;

  v_replace := $a$v_is_delivery := (v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria');

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
  END IF;$a$;

  v_src := replace(v_src, v_anchor, v_replace);

  -- (B) Feed find_best_drivers the real package specs instead of five NULLs.
  -- Argument order per the live signature:
  --   … p_estimated_trip_distance_m, p_package_category, p_estimated_weight_kg,
  --     p_package_length_cm, p_package_width_cm, p_package_height_cm,
  --     p_corporate_account_id
  -- For a passenger ride these sub-selects find no row and yield NULL, which is
  -- exactly what was passed before — so passenger dispatch is untouched.
  v_anchor := $b$    v_ride.estimated_distance_m,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    v_ride.corporate_account_id$b$;

  IF position(v_anchor IN v_src) = 0 THEN
    RAISE EXCEPTION '00512: anchor B not found in dispatch_ride — refusing to apply a partial patch';
  END IF;

  v_replace := $b$    v_ride.estimated_distance_m,
    (SELECT dd.package_category  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.estimated_weight_kg FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_length_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_width_cm  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_height_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    v_ride.corporate_account_id$b$;

  v_src := replace(v_src, v_anchor, v_replace);

  EXECUTE v_src;
  RAISE NOTICE '00512: dispatch_ride patched (cargo by ride_mode + real package specs)';
END $patch$;

-- ── C: re-dispatch as soon as the package specs land ─────────────────────────
CREATE OR REPLACE FUNCTION public.tg_dispatch_on_delivery_details()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status       TEXT;
  v_is_scheduled BOOLEAN;
  v_scheduled_at TIMESTAMPTZ;
BEGIN
  SELECT r.status::text, r.is_scheduled, r.scheduled_at
    INTO v_status, v_is_scheduled, v_scheduled_at
  FROM rides r WHERE r.id = NEW.ride_id;

  -- Same scheduling guard as on_ride_insert_dispatch, so a delivery booked for
  -- later is not pulled forward just because its specs were saved now.
  IF v_status = 'searching'
     AND (v_is_scheduled IS NOT TRUE
          OR v_scheduled_at IS NULL
          OR v_scheduled_at <= now()) THEN
    -- dispatch_ride's internal "internal-only" gate passes here because
    -- pg_trigger_depth() > 0.
    PERFORM dispatch_ride(NEW.ride_id);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a dispatch problem block the client's INSERT: the ride still
  -- exists and the cron will pick it up.
  RAISE WARNING '[dispatch_on_delivery_details] ride %: % %', NEW.ride_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_dispatch_on_delivery_details() IS
  '00512: re-dispatches a cargo ride once its delivery_details land, closing the '
  'window where dispatch_ride deferred for want of package specs.';

DROP TRIGGER IF EXISTS trg_dispatch_on_delivery_details ON public.delivery_details;
CREATE TRIGGER trg_dispatch_on_delivery_details
  AFTER INSERT ON public.delivery_details
  FOR EACH ROW EXECUTE FUNCTION public.tg_dispatch_on_delivery_details();

-- ── D: let the cron see deferred rides ───────────────────────────────────────
-- retry_dispatch_expired_rides filters `dispatch_round >= 1`. A deferred cargo
-- ride has dispatch_round = 0, so the safety net would never have caught it.
-- It also compares last_dispatched_at, which is NULL until something dispatches
-- (24 rides in production have it NULL) — NULL < anything is NULL, so the row is
-- filtered out. Both are widened here.
DO $patch$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef('public.retry_dispatch_expired_rides()'::regprocedure) INTO v_src;

  IF position($g$OR ride_mode = 'cargo'$g$ IN v_src) > 0 THEN
    RAISE NOTICE '00512: retry_dispatch_expired_rides already patched — skipping';
    RETURN;
  END IF;

  IF position($g$AND dispatch_round >= 1$g$ IN v_src) = 0
     OR position($g$AND last_dispatched_at < now() - interval '30 seconds'$g$ IN v_src) = 0 THEN
    RAISE EXCEPTION '00512: anchors not found in retry_dispatch_expired_rides — refusing to apply a silent no-op';
  END IF;

  v_src := replace(v_src,
    $g$AND dispatch_round >= 1$g$,
    $g$AND (dispatch_round >= 1 OR ride_mode = 'cargo')$g$);

  v_src := replace(v_src,
    $g$AND last_dispatched_at < now() - interval '30 seconds'$g$,
    $g$AND COALESCE(last_dispatched_at, created_at) < now() - interval '30 seconds'$g$);

  EXECUTE v_src;
  RAISE NOTICE '00512: retry_dispatch_expired_rides patched (picks up deferred cargo rides)';
END $patch$;
