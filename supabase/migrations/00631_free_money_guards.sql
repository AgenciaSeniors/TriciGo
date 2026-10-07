-- ============================================================
-- 00631 — no free money from promos, referrals or admin gifts
--
-- WHY (each one reproduced in prod on 2026-10-07 inside a rolled-back block)
--   1. The client sets rides.estimated_fare_cup and nothing caps it.
--      tg_rides_validate_estimated_fare only checks the floor, the AFTER
--      INSERT snapshot stores that number as the contract, and
--      complete_ride_and_pay charges it. With a promo above the commission
--      (SUPERFLA and BIENVENIDA are 25 %, the commission 15 %) the promo
--      subsidy pays the driver more than the platform keeps: a 300 m ride
--      asked at 1,000,000 CUP with SUPERFLA and completed by a real driver
--      left the driver +100,000 in tricicoin, platform_promotions −212,500
--      and platform_revenue +112,500. A rider and a driver who agree can mint
--      10 % of any fare they choose. The client also sends surge_multiplier,
--      which the snapshot keeps and the waypoint surcharge multiplies by.
--   2. A promo is claimed (promotion_uses + current_uses) only when the ride
--      is created. tg_rides_validate_promo_discount also runs on UPDATE OF
--      promo_code_id and applies the discount again without claiming
--      anything, and enforce_ride_update_columns lets the customer change
--      promo_code_id. Measured: one promo use claimed, three rides with the
--      discount.
--   3. Once a ride has stops, the snapshot total includes the waypoint
--      surcharge, and that promo trigger uses the total as its base: any
--      later UPDATE that re-fires it (the customer may change the dropoff)
--      applies the promo percentage to the stops too. A stop at the other
--      end of the island makes the same mint as point 1 without touching
--      estimated_fare_cup.
--   4. The rider referral bonus (trg_referral_reward_on_complete) pays the
--      referrer when the referee completes a first ride, whoever drove it.
--      The referrer could drive the referee themselves. The driver path
--      (00615) already excludes rides between the two.
--   5. admin_send_gift lets an admin gift themselves, with no cap.
--      admin_adjust_wallet already refuses the admin's own wallet.
--   6. The policy ref_insert lets any signed-in user insert a referral row
--      for themselves directly, with any referrer and any code, skipping the
--      checks of apply_referral_code (the code exists, its owner is active).
--      Every writer of referrals is a SECURITY DEFINER function.
--
-- WHAT
--   tg_rides_validate_estimated_fare (BEFORE INSERT ON rides), for a JWT
--   that is not an admin (the service role, crons and admins are not
--   checked):
--     - surge_multiplier is clamped to [1, 3], the range of get_weather_surge().
--     - The estimate may not exceed a ceiling: the most expensive active
--       band of the service (max base, per km, per minute and minimum over
--       its pricing_rules and its service_type_configs row) applied to a
--       route of 4 × the straight distance + 5 km at 10 km/h, times the
--       surge, times 1.5. Over 234 rides with a fare in prod the highest
--       estimate is 0.50 of its ceiling (p99 0.26). Above it the insert
--       fails with a Spanish MESSAGE and DETAIL fare_above_ceiling.
--     - The floor is unchanged.
--   tg_rides_validate_promo_discount (the body 00628 left):
--     - On UPDATE, a JWT that is not an admin cannot change promo_code_id:
--       it is put back to its old value (silently, like the other protected
--       columns). Admins and the service role still can, so deleting a
--       promotion (ON DELETE SET NULL, 00492) keeps working.
--     - On UPDATE by such a JWT, the promo part of the discount may go down
--       but never up: it stays at most what it was. The promo was priced when
--       the ride was created (the stops' surcharge comes later and never
--       re-fired this trigger), so an honest ride loses nothing. A type
--       change from support (_apply_ride_service_change sets
--       app.force_discount_recompute, 00628) recomputes freely, as do admins
--       and the service role.
--   trg_referral_reward_on_complete: a ride driven by the referrer or the
--     referee pays nothing, and only the referee's first completed ride with
--     another driver counts, like the driver path.
--   admin_send_gift: refuses p_to_user_id = p_admin_user_id.
--   referrals: ref_insert is dropped, and anon/authenticated lose INSERT,
--     UPDATE, DELETE and TRUNCATE. apply_referral_code and the reward and
--     admin functions (all SECURITY DEFINER) keep writing it.
--
-- KNOWN LIMITS
--   - A multi-stop ride is priced by the client with its stops, and the
--     ceiling only knows pickup and dropoff: a stop more than ~2.5 km off a
--     short trip can exceed it. 1 ride with stops in the last 120 days; its
--     estimate was 0.16 of the ceiling.
--   - A promo may still be worth more than the commission on an honest
--     ride; this caps how big the fare can be, not the promo itself.
--
-- Bodies are patched from the live definition (md5-checked) so nothing else
-- in them can be lost; the migration refuses a body it does not know.
-- Rehearsal: supabase/tests/00631/run.sh
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_rides_validate_estimated_fare()');
  IF v_md5 IS DISTINCT FROM '4dda5399794d28088b3537488516073d' -- before 00631
     AND v_md5 IS DISTINCT FROM 'bd038e5d88e99e3377b5d8787d8f68b1' THEN -- 00631
    RAISE EXCEPTION '00631: unexpected body of tg_rides_validate_estimated_fare (md5 %), not replacing it', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_rides_validate_promo_discount()');
  IF v_md5 IS DISTINCT FROM 'ae9f33f11fe3b6a3cd0f118e3bf7a0c4' -- 00628, before 00631
     AND v_md5 IS DISTINCT FROM 'b70dc359fccf82f5d5b3209ca03e9816' THEN -- 00631
    RAISE EXCEPTION '00631: unexpected body of tg_rides_validate_promo_discount (md5 %), not patching it', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.trg_referral_reward_on_complete()');
  IF v_md5 IS DISTINCT FROM '7f5dcb0663accaf345f2e16374a0545c' -- before 00631
     AND v_md5 IS DISTINCT FROM '2f0a51cac7603e1c7bda7228e06e97f6' THEN -- 00631
    RAISE EXCEPTION '00631: unexpected body of trg_referral_reward_on_complete (md5 %), not patching it', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.admin_send_gift(uuid, integer, text, uuid)');
  IF v_md5 IS DISTINCT FROM '2654fff52873011b822f4d44db72ef7d' -- before 00631
     AND v_md5 IS DISTINCT FROM '8aac30f1c704121c8f7152b2f310f7ec' THEN -- 00631
    RAISE EXCEPTION '00631: unexpected body of admin_send_gift (md5 %), not patching it', v_md5;
  END IF;
END
$pre$;

-- 1. Fare ceiling and surge clamp at ride creation. ------------------------

CREATE OR REPLACE FUNCTION public.tg_rides_validate_estimated_fare()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_min integer;
  v_client boolean := auth.uid() IS NOT NULL AND NOT is_admin();
  v_base numeric;
  v_per_km numeric;
  v_per_min numeric;
  v_min_fare numeric;
  v_route_km numeric;
  v_ceiling numeric;
BEGIN
  -- 00631: the only surge left is the weather one, which get_weather_surge()
  -- keeps in [1, 3]. A client may not declare more (the snapshot keeps it and
  -- the waypoint surcharge multiplies by it).
  IF v_client THEN
    NEW.surge_multiplier := LEAST(GREATEST(COALESCE(NEW.surge_multiplier, 1), 1), 3);
  END IF;

  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT min_fare_cup INTO v_min
  FROM service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF v_min IS NULL THEN
    SELECT MIN(min_fare_cup) INTO v_min
    FROM pricing_rules
    WHERE service_type = NEW.service_type AND is_active = true;
  END IF;

  IF v_min IS NOT NULL AND v_min > 0 AND NEW.estimated_fare_cup < v_min THEN
    RAISE EXCEPTION 'estimated_fare_cup % is below the minimum fare % for service % (server-side fare floor / tamper guard)',
      NEW.estimated_fare_cup, v_min, NEW.service_type;
  END IF;

  -- 00631: the ceiling. The snapshot taken after this insert is what
  -- complete_ride_and_pay charges, and a promo above the commission pays the
  -- driver a share of it, so the fare a client declares must be one the
  -- tariff could produce: the most expensive band of the service, a route of
  -- 4 x the straight distance + 5 km driven at 10 km/h (6 min per km), the
  -- surge, and 50 % on top.
  IF v_client THEN
    SELECT max(t.base_fare_cup), max(t.per_km_rate_cup), max(t.per_minute_rate_cup), max(t.min_fare_cup)
      INTO v_base, v_per_km, v_per_min, v_min_fare
    FROM (
      SELECT s.base_fare_cup, s.per_km_rate_cup, s.per_minute_rate_cup, s.min_fare_cup
      FROM service_type_configs s WHERE s.slug = NEW.service_type
      UNION ALL
      SELECT p.base_fare_cup, p.per_km_rate_cup, p.per_minute_rate_cup, p.min_fare_cup
      FROM pricing_rules p WHERE p.service_type = NEW.service_type AND p.is_active
    ) t;

    v_route_km := ST_Distance(NEW.pickup_location, NEW.dropoff_location) / 1000.0 * 4 + 5;
    v_ceiling := ceil(
      GREATEST(COALESCE(v_min_fare, 0),
               COALESCE(v_base, 0) + COALESCE(v_per_km, 0) * v_route_km
                 + COALESCE(v_per_min, 0) * v_route_km * 6)
      * NEW.surge_multiplier * 1.5);

    IF v_ceiling > 0 AND NEW.estimated_fare_cup > v_ceiling THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'No pudimos confirmar el precio de este viaje. Vuelve a calcularlo e inténtalo de nuevo.',
        DETAIL = 'fare_above_ceiling',
        HINT = format('estimated_fare_cup %s is above the ceiling %s for %s', NEW.estimated_fare_cup, v_ceiling, NEW.service_type);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. The promo is fixed when the ride is created. ---------------------------
--    Needs 00628 first: its guard refuses any body but the one before it, so
--    the order matters.

DO $promo$
DECLARE
  v_def text := pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure);
  v_lock_anchor text := E'BEGIN\n  -- 00492: deleting a promotion cascades';
  v_cap_anchor text := E'  -- 00559: promo y lugar aliado NO se suman';
BEGIN
  IF position('00631' IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF (length(v_def) - length(replace(v_def, v_lock_anchor, ''))) / length(v_lock_anchor) <> 1
     OR (length(v_def) - length(replace(v_def, v_cap_anchor, ''))) / length(v_cap_anchor) <> 1 THEN
    RAISE EXCEPTION '00631: the anchors of tg_rides_validate_promo_discount are not unique';
  END IF;

  v_def := replace(v_def, v_lock_anchor,
    E'BEGIN\n'
    '  -- 00631: a promo is claimed once, when the ride is created. A client may\n'
    '  -- not attach, swap or drop it afterwards: every UPDATE applied the\n'
    '  -- discount again without claiming a use. Admins and the service role\n'
    '  -- still can (deleting a promotion sets it to NULL, see 00492 below).\n'
    '  IF TG_OP = ''UPDATE''\n'
    '     AND NEW.promo_code_id IS DISTINCT FROM OLD.promo_code_id\n'
    '     AND auth.uid() IS NOT NULL\n'
    '     AND NOT is_admin() THEN\n'
    '    NEW.promo_code_id := OLD.promo_code_id;\n'
    '  END IF;\n'
    '\n'
    '  -- 00492: deleting a promotion cascades');

  v_def := replace(v_def, v_cap_anchor,
    E'  -- 00631: a client''s UPDATE may lower the promo part of the discount but\n'
    '  -- never raise it. The promo was priced when the ride was created; a\n'
    '  -- recompute on a grown base (a far stop''s surcharge is in the snapshot\n'
    '  -- total) applied the percentage to the stops too. A type change from\n'
    '  -- support (app.force_discount_recompute, 00628), admins and the service\n'
    '  -- role recompute freely.\n'
    '  IF TG_OP = ''UPDATE''\n'
    '     AND auth.uid() IS NOT NULL\n'
    '     AND NOT is_admin()\n'
    '     AND COALESCE(current_setting(''app.force_discount_recompute'', true), '''') <> ''1'' THEN\n'
    '    v_correct_discount := LEAST(v_correct_discount, GREATEST(\n'
    '      COALESCE(OLD.discount_amount_cup, 0) - COALESCE(OLD.partner_discount_cup, 0)\n'
    '        - COALESCE(OLD.shared_ride_discount_cup, 0), 0));\n'
    '  END IF;\n'
    '\n'
    || v_cap_anchor);

  EXECUTE v_def;
END
$promo$;

-- 3. The rider referral does not pay for rides between the two. -------------

DO $referral$
DECLARE
  v_def text := pg_get_functiondef('public.trg_referral_reward_on_complete()'::regprocedure);
  v_anchor text := E'  SELECT COUNT(*) INTO v_completed_count\n  FROM rides\n  WHERE customer_id = NEW.customer_id\n    AND status = ''completed'';';
BEGIN
  IF position('00631' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION '00631: the anchor of trg_referral_reward_on_complete is not unique';
  END IF;

  v_def := replace(v_def, v_anchor,
    E'  -- 00631: a ride driven by the referrer or the referee pays nothing, and\n'
    '  -- only the referee''s first completed ride with another driver counts\n'
    '  -- (this one included: the trigger runs AFTER the update). Same rule as\n'
    '  -- the driver path (00615).\n'
    '  IF NEW.driver_id IS NULL OR EXISTS (\n'
    '    SELECT 1 FROM driver_profiles dp\n'
    '    WHERE dp.id = NEW.driver_id\n'
    '      AND dp.user_id IN (v_ref.referrer_id, v_ref.referee_id)\n'
    '  ) THEN\n'
    '    RETURN NEW;\n'
    '  END IF;\n'
    '\n'
    '  SELECT COUNT(*) INTO v_completed_count\n'
    '  FROM rides r\n'
    '  WHERE r.customer_id = NEW.customer_id\n'
    '    AND r.status = ''completed''\n'
    '    AND r.driver_id IS NOT NULL\n'
    '    AND NOT EXISTS (\n'
    '      SELECT 1 FROM driver_profiles dp\n'
    '      WHERE dp.id = r.driver_id\n'
    '        AND dp.user_id IN (v_ref.referrer_id, v_ref.referee_id)\n'
    '    );');

  EXECUTE v_def;
END
$referral$;

-- 4. An admin cannot gift themselves. ---------------------------------------

DO $gift$
DECLARE
  v_def text := pg_get_functiondef('public.admin_send_gift(uuid, integer, text, uuid)'::regprocedure);
  v_anchor text := E'  IF p_amount <= 0 THEN\n    RAISE EXCEPTION ''Gift amount must be positive'';';
BEGIN
  IF position('00631' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION '00631: the anchor of admin_send_gift is not unique';
  END IF;

  v_def := replace(v_def, v_anchor,
    E'  -- 00631: like admin_adjust_wallet, never the admin''s own wallet.\n'
    '  IF p_to_user_id = p_admin_user_id THEN\n'
    '    RAISE EXCEPTION USING\n'
    '      ERRCODE = ''P0001'',\n'
    '      MESSAGE = ''No puedes enviarte un regalo a ti mismo.'',\n'
    '      DETAIL = ''gift_to_self'';\n'
    '  END IF;\n'
    || v_anchor);

  EXECUTE v_def;
END
$gift$;

-- 5. Referrals are written only by their functions. -------------------------

DROP POLICY IF EXISTS ref_insert ON public.referrals;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.referrals FROM anon, authenticated;

-- Pasted into the SQL Editor from Windows, the bodies above carry \r\n line
-- ends: they work, but no longer match git. Recreate them without the \r
-- (CREATE OR REPLACE keeps their grants).
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.tg_rides_validate_estimated_fare()'::regprocedure,
    'public.tg_rides_validate_promo_discount()'::regprocedure,
    'public.trg_referral_reward_on_complete()'::regprocedure,
    'public.admin_send_gift(uuid, integer, text, uuid)'::regprocedure]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- Assert the end state.
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_validate_estimated_fare()'::regprocedure)
     IS DISTINCT FROM 'bd038e5d88e99e3377b5d8787d8f68b1' THEN
    RAISE EXCEPTION '00631: tg_rides_validate_estimated_fare is not the 00631 body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_validate_promo_discount()'::regprocedure)
     IS DISTINCT FROM 'b70dc359fccf82f5d5b3209ca03e9816' THEN
    RAISE EXCEPTION '00631: tg_rides_validate_promo_discount is not the 00631 body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.trg_referral_reward_on_complete()'::regprocedure)
     IS DISTINCT FROM '2f0a51cac7603e1c7bda7228e06e97f6' THEN
    RAISE EXCEPTION '00631: trg_referral_reward_on_complete is not the 00631 body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.admin_send_gift(uuid, integer, text, uuid)'::regprocedure)
     IS DISTINCT FROM '8aac30f1c704121c8f7152b2f310f7ec' THEN
    RAISE EXCEPTION '00631: admin_send_gift is not the 00631 body';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass AND tgname = 'trg_rides_validate_estimated_fare'
                   AND tgenabled = 'O' AND tgfoid = 'public.tg_rides_validate_estimated_fare()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass AND tgname = 'rides_validate_promo_discount'
                   AND tgenabled = 'O' AND tgfoid = 'public.tg_rides_validate_promo_discount()'::regprocedure)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass AND tgname = 'trg_referral_reward_on_complete'
                   AND tgenabled = 'O' AND tgfoid = 'public.trg_referral_reward_on_complete()'::regprocedure) THEN
    RAISE EXCEPTION '00631: a rides trigger this migration relies on is missing or disabled';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.referrals'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION '00631: referrals still has a write policy';
  END IF;
  IF has_table_privilege('anon', 'public.referrals', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.referrals', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '00631: anon or authenticated can still write referrals';
  END IF;
END
$check$;

RESET lock_timeout;
