-- ============================================================
-- 00686: a ride the dead-driver job took away goes back to its driver
--        when he shows up again
-- ============================================================
-- Incident 2026-11-17 (ride c4d2110e): Misael accepted Luis's moto ride at
-- 16:28 (Havana) and drove it. His phone sent nothing for 17 minutes (no data
-- or a suspended app). At 16:45:00 release_rides_from_dead_drivers (00542,
-- 12 minutes of silence) put the ride back to `searching` and offered it to
-- five other drivers. Eighteen seconds later his phone came back:
--   - update_ride_status_v2 answered "Forbidden" (the ride had no driver);
--   - the ~30 GPS points of the trip were dropped by the 00659 guard;
--   - the app told him the ride had been passed to someone else.
-- Luis reopened his app, saw the ride searching again and cancelled it. A ride
-- that happened is recorded as cancelled, with no commission.
--
-- Measured in prod, 90 days: the job released 9 rides. None was taken by
-- another driver; all 9 ended cancelled. In 7, the same driver was heard from
-- again within 10 minutes while the ride was still searching (0.2 to 9.7 min).
--
-- The release stays: a driver who is really gone still frees the ride. What
-- this adds is the way back:
--   1. dead_driver_releases records which driver lost which ride, with the
--      accepted_at, custom rate and pickup-proximity mark he had.
--   2. _reclaim_released_ride(driver): while the ride is still `searching`
--      with no driver, and within dead_driver_reclaim_window_min (15; 0 turns
--      it off) of the release, the ride goes back to `accepted` with him. It
--      only acts on a sign of life from the driver himself (his own JWT), never
--      on a heartbeat an admin sends for him.
--   3. update_driver_position and driver_heartbeat, the calls the driver app
--      makes first when it comes back, run the reclaim in their own block: a
--      failure there never costs the position or the heartbeat.
--   4. tg_ride_location_events_guard keeps the points of the released driver
--      while the ride has no driver (same window). They are the record of the
--      trip, and they are his trail if he gets the ride back.
--
-- Nothing changes for a ride another driver accepted, or one the passenger
-- cancelled: the reclaim needs `searching` and no driver.
--
-- The four existing functions are patched in place from their live bodies
-- (md5-guarded, idempotent). A migration that redefines any of them must start
-- from the bodies this one leaves (md5s in the checks at the end).
-- Rehearsal: supabase/tests/00686/run.sh.
-- ============================================================

-- 1. The window -------------------------------------------------------------
INSERT INTO public.platform_config (key, value)
VALUES ('dead_driver_reclaim_window_min', to_jsonb(15))
ON CONFLICT (key) DO NOTHING;

-- 2. Who lost which ride -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dead_driver_releases (
  ride_id                      uuid PRIMARY KEY REFERENCES public.rides (id) ON DELETE CASCADE,
  driver_profile_id            uuid NOT NULL REFERENCES public.driver_profiles (id) ON DELETE CASCADE,
  accepted_at                  timestamptz,
  driver_custom_rate_cup       integer,
  proximity_pickup_notified_at timestamptz,
  released_at                  timestamptz NOT NULL DEFAULT now(),
  reclaimed_at                 timestamptz
);
CREATE INDEX IF NOT EXISTS dead_driver_releases_open_by_driver
  ON public.dead_driver_releases (driver_profile_id, released_at DESC)
  WHERE reclaimed_at IS NULL;

-- Lock table: only the SECURITY DEFINER functions below and the service role.
ALTER TABLE public.dead_driver_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dead_driver_releases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dead_driver_releases TO service_role;

-- 3. The release records what it took ----------------------------------------
DO $patch$
DECLARE
  c_old  constant text := 'cdfaba6fef339647c23c7fcb0a6de317';
  v_src  text;
  v_new  text;
  v_md5  text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = 'public.release_rides_from_dead_drivers()'::regprocedure;

  IF v_md5 <> c_old THEN
    IF position('00686' IN (SELECT prosrc FROM pg_proc
                            WHERE oid = 'public.release_rides_from_dead_drivers()'::regprocedure)) > 0 THEN
      RETURN;  -- already patched
    END IF;
    RAISE EXCEPTION '00686: release_rides_from_dead_drivers is not the body this migration patches (md5 %)', v_md5;
  END IF;

  v_src := pg_get_functiondef('public.release_rides_from_dead_drivers()'::regprocedure);
  v_new := replace(v_src,
    E'    SELECT rd.id, rd.customer_id, rd.driver_id, rd.status\n    FROM rides rd\n',
    E'    SELECT rd.id, rd.customer_id, rd.driver_id, rd.status,\n'
    || E'           rd.accepted_at, rd.driver_custom_rate_cup, rd.proximity_pickup_notified_at\n'
    || E'    FROM rides rd\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION '00686: release_rides_from_dead_drivers select anchor not found';
  END IF;
  v_src := v_new;
  v_new := replace(v_new,
    E'      PERFORM public._reopen_ride_offers(r.id, r.driver_id);\n',
    E'      PERFORM public._reopen_ride_offers(r.id, r.driver_id);\n'
    || E'\n'
    || E'      -- 00686: remember who lost it. If he shows up again while the ride is\n'
    || E'      -- still searching, _reclaim_released_ride gives it back to him.\n'
    || E'      INSERT INTO public.dead_driver_releases (ride_id, driver_profile_id, accepted_at,\n'
    || E'        driver_custom_rate_cup, proximity_pickup_notified_at, released_at, reclaimed_at)\n'
    || E'      VALUES (r.id, r.driver_id, r.accepted_at, r.driver_custom_rate_cup,\n'
    || E'        r.proximity_pickup_notified_at, now(), NULL)\n'
    || E'      ON CONFLICT (ride_id) DO UPDATE SET\n'
    || E'        driver_profile_id = EXCLUDED.driver_profile_id,\n'
    || E'        accepted_at = EXCLUDED.accepted_at,\n'
    || E'        driver_custom_rate_cup = EXCLUDED.driver_custom_rate_cup,\n'
    || E'        proximity_pickup_notified_at = EXCLUDED.proximity_pickup_notified_at,\n'
    || E'        released_at = EXCLUDED.released_at,\n'
    || E'        reclaimed_at = NULL;\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION '00686: release_rides_from_dead_drivers offers anchor not found';
  END IF;
  EXECUTE v_new;
END
$patch$;

-- 4. The reclaim -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._reclaim_released_ride(p_driver_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_window  integer;
  v_user    uuid;
  v_status  text;
  v_rel     public.dead_driver_releases%ROWTYPE;
  v_ride    public.rides%ROWTYPE;
BEGIN
  v_window := COALESCE(public.get_platform_config_numeric('dead_driver_reclaim_window_min', 15), 15)::integer;
  IF v_window <= 0 THEN
    RETURN NULL;
  END IF;

  -- A sign of life from the driver himself. A heartbeat an admin sends for him
  -- says nothing about where he is.
  SELECT user_id, status INTO v_user, v_status
  FROM public.driver_profiles WHERE id = p_driver_id;
  IF v_user IS NULL OR auth.uid() IS DISTINCT FROM v_user OR v_status IS DISTINCT FROM 'approved' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_rel
  FROM public.dead_driver_releases d
  WHERE d.driver_profile_id = p_driver_id
    AND d.reclaimed_at IS NULL
    AND d.released_at > now() - make_interval(mins => v_window)
  ORDER BY d.released_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- He took another ride since: that one is his now.
  IF EXISTS (
    SELECT 1 FROM public.rides
    WHERE driver_id = p_driver_id
      AND status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
  ) THEN
    RETURN NULL;
  END IF;

  -- Same lock as accept_ride_v2 and cancel_ride: whoever gets the row first
  -- wins, and the other sees a ride that is no longer searching.
  SELECT * INTO v_ride FROM public.rides WHERE id = v_rel.ride_id FOR UPDATE;
  IF NOT FOUND OR v_ride.status <> 'searching' OR v_ride.driver_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- The columns accept_ride_v2 writes, with the values he had when he lost it.
  UPDATE public.rides
  SET status                       = 'accepted',
      driver_id                    = p_driver_id,
      accepted_at                  = COALESCE(v_rel.accepted_at, now()),
      driver_custom_rate_cup       = v_rel.driver_custom_rate_cup,
      proximity_pickup_notified_at = v_rel.proximity_pickup_notified_at
  WHERE id = v_ride.id AND status = 'searching' AND driver_id IS NULL;

  -- The offers sent while it was searching lose, as when a driver accepts.
  UPDATE public.ride_offers
  SET status = 'superseded', responded_at = now()
  WHERE ride_id = v_ride.id AND status = 'pending' AND driver_profile_id <> p_driver_id;

  UPDATE public.dead_driver_releases SET reclaimed_at = now() WHERE ride_id = v_ride.id;

  -- Proof of life. Without it the next pass of the release job (every 5 min)
  -- would see the old heartbeat and take the ride away again.
  UPDATE public.driver_profiles SET last_heartbeat_at = now() WHERE id = p_driver_id;

  PERFORM public.log_rpc_attempt('reclaim_released_ride', auth.uid(), v_ride.id, 'success',
    jsonb_build_object('driver_profile_id', p_driver_id, 'released_at', v_rel.released_at));
  RETURN v_ride.id;
END;
$fn$;

REVOKE ALL ON FUNCTION public._reclaim_released_ride(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reclaim_released_ride(uuid) TO service_role;

-- 5. Where the driver app shows up first --------------------------------------
-- update_driver_position: before the point is written, so that point is kept.
DO $patch$
DECLARE
  c_sig  constant text := 'public.update_driver_position(uuid, double precision, double precision, double precision, double precision, uuid)';
  c_old  constant text := '63dfd68a1d8b7ff1f689e3acb4ee7937';
  v_src  text;
  v_new  text;
  v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE oid = c_sig::regprocedure;
  IF md5(v_body) <> c_old THEN
    IF position('00686' IN v_body) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '00686: update_driver_position is not the body this migration patches (md5 %)', md5(v_body);
  END IF;

  v_src := pg_get_functiondef(c_sig::regprocedure);
  v_new := replace(v_src,
    E'  -- 2) If active ride, also append to ride_location_events\n',
    E'  -- 00686: a ride the dead-driver job took from him while he was silent comes\n'
    || E'  -- back to him, before this point is written. Own block: a failure there\n'
    || E'  -- never costs the position update.\n'
    || E'  IF EXISTS (SELECT 1 FROM dead_driver_releases d\n'
    || E'             WHERE d.driver_profile_id = p_driver_id AND d.reclaimed_at IS NULL\n'
    || E'               AND d.released_at > now() - make_interval(mins => GREATEST(0, COALESCE(\n'
    || E'                     public.get_platform_config_numeric(''dead_driver_reclaim_window_min'', 15), 15))::integer)) THEN\n'
    || E'    BEGIN\n'
    || E'      PERFORM public._reclaim_released_ride(p_driver_id);\n'
    || E'    EXCEPTION WHEN OTHERS THEN\n'
    || E'      RAISE WARNING ''[update_driver_position] reclaim failed for %: % %'', p_driver_id, SQLSTATE, SQLERRM;\n'
    || E'      PERFORM public.log_rpc_attempt(''reclaim_released_ride'', v_caller, NULL, ''reclaim_failed'',\n'
    || E'        jsonb_build_object(''driver_profile_id'', p_driver_id, ''sqlstate'', SQLSTATE, ''error'', SQLERRM));\n'
    || E'    END;\n'
    || E'  END IF;\n'
    || E'\n'
    || E'  -- 2) If active ride, also append to ride_location_events\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION '00686: update_driver_position anchor not found';
  END IF;
  EXECUTE v_new;
END
$patch$;

-- driver_heartbeat: right after the heartbeat, before the auto-restore (which
-- can RETURN early when it is switched off).
DO $patch$
DECLARE
  c_old  constant text := '28e4729adc5b37535db370930328a734';
  v_src  text;
  v_new  text;
  v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE oid = 'public.driver_heartbeat(uuid)'::regprocedure;
  IF md5(v_body) <> c_old THEN
    IF position('00686' IN v_body) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '00686: driver_heartbeat is not the body this migration patches (md5 %)', md5(v_body);
  END IF;

  v_src := pg_get_functiondef('public.driver_heartbeat(uuid)'::regprocedure);
  v_new := replace(v_src,
    E'  SET last_heartbeat_at = NOW()\n  WHERE id = p_driver_id;\n',
    E'  SET last_heartbeat_at = NOW()\n  WHERE id = p_driver_id;\n'
    || E'\n'
    || E'  -- 00686: a ride the dead-driver job took from him while he was silent comes\n'
    || E'  -- back to him. Own block: a failure there never costs the heartbeat.\n'
    || E'  IF EXISTS (SELECT 1 FROM dead_driver_releases d\n'
    || E'             WHERE d.driver_profile_id = p_driver_id AND d.reclaimed_at IS NULL\n'
    || E'               AND d.released_at > now() - make_interval(mins => GREATEST(0, COALESCE(\n'
    || E'                     public.get_platform_config_numeric(''dead_driver_reclaim_window_min'', 15), 15))::integer)) THEN\n'
    || E'    BEGIN\n'
    || E'      PERFORM public._reclaim_released_ride(p_driver_id);\n'
    || E'    EXCEPTION WHEN OTHERS THEN\n'
    || E'      RAISE WARNING ''[driver_heartbeat] reclaim failed for %: % %'', p_driver_id, SQLSTATE, SQLERRM;\n'
    || E'      PERFORM public.log_rpc_attempt(''reclaim_released_ride'', auth.uid(), NULL, ''reclaim_failed'',\n'
    || E'        jsonb_build_object(''driver_profile_id'', p_driver_id, ''sqlstate'', SQLSTATE, ''error'', SQLERRM));\n'
    || E'    END;\n'
    || E'  END IF;\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION '00686: driver_heartbeat anchor not found';
  END IF;
  EXECUTE v_new;
END
$patch$;

-- 6. The trail of a released driver is kept ------------------------------------
DO $patch$
DECLARE
  c_old  constant text := 'a6af4796e5d96697a993127b819def6d';
  v_src  text;
  v_new  text;
  v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE oid = 'public.tg_ride_location_events_guard()'::regprocedure;
  IF md5(v_body) <> c_old THEN
    IF position('00686' IN v_body) > 0 THEN
      RETURN;
    END IF;
    RAISE EXCEPTION '00686: tg_ride_location_events_guard is not the body this migration patches (md5 %)', md5(v_body);
  END IF;

  v_src := pg_get_functiondef('public.tg_ride_location_events_guard()'::regprocedure);
  v_new := replace(v_src,
    E'    WHERE r.id = NEW.ride_id AND r.driver_id = NEW.driver_id\n  ) THEN\n',
    E'    WHERE r.id = NEW.ride_id AND r.driver_id = NEW.driver_id\n'
    || E'  ) AND NOT EXISTS (\n'
    || E'    -- 00686: the driver the dead-driver job took this ride from, while nobody\n'
    || E'    -- has it: his points are the record of the trip, and his trail if he gets\n'
    || E'    -- it back. The proximity push only runs for a ride with a driver.\n'
    || E'    SELECT 1 FROM public.rides r\n'
    || E'    JOIN public.dead_driver_releases d ON d.ride_id = r.id\n'
    || E'    WHERE r.id = NEW.ride_id\n'
    || E'      AND r.driver_id IS NULL\n'
    || E'      AND d.driver_profile_id = NEW.driver_id\n'
    || E'      AND d.reclaimed_at IS NULL\n'
    || E'      AND d.released_at > now() - make_interval(mins => GREATEST(0,\n'
    || E'            COALESCE(public.get_platform_config_numeric(''dead_driver_reclaim_window_min'', 15), 15))::integer)\n'
    || E'  ) THEN\n');
  IF v_new = v_src THEN
    RAISE EXCEPTION '00686: tg_ride_location_events_guard anchor not found';
  END IF;
  EXECUTE v_new;
END
$patch$;

-- 7. A copy pasted from Windows brings \r into the body of the new function.
DO $crlf$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public._reclaim_released_ride(uuid)'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- 8. Checks ------------------------------------------------------------------
DO $check$
DECLARE
  v_md5 text;
  v_bad text;
BEGIN
  FOR v_bad, v_md5 IN
    SELECT f.sig, md5(p.prosrc)
    FROM (VALUES
      ('public.release_rides_from_dead_drivers()', '90f9fe8b2249722128d7887380867534'),
      ('public._reclaim_released_ride(uuid)', '638c90286e1a40992a3e236014a0bf24'),
      ('public.update_driver_position(uuid, double precision, double precision, double precision, double precision, uuid)', 'bf109db435c78b428cba1d14fe4dc954'),
      ('public.driver_heartbeat(uuid)', '81afe7bd583d08f172f99de4a2bac41c'),
      ('public.tg_ride_location_events_guard()', '6d0986059b39608f0458172f2e9f37d8')
    ) AS f(sig, expected)
    JOIN pg_proc p ON p.oid = f.sig::regprocedure
    WHERE md5(p.prosrc) <> f.expected
  LOOP
    RAISE EXCEPTION '00686: % ended with an unexpected body (md5 %)', v_bad, v_md5;
  END LOOP;

  IF has_function_privilege('anon', 'public._reclaim_released_ride(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._reclaim_released_ride(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00686: clients can call _reclaim_released_ride';
  END IF;
  IF has_table_privilege('anon', 'public.dead_driver_releases', 'SELECT')
     OR has_table_privilege('authenticated', 'public.dead_driver_releases', 'SELECT')
     OR has_table_privilege('authenticated', 'public.dead_driver_releases', 'INSERT') THEN
    RAISE EXCEPTION '00686: clients can read or write dead_driver_releases';
  END IF;
END
$check$;
