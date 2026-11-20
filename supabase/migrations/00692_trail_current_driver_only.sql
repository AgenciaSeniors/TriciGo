-- 00692_trail_current_driver_only.sql
--
-- A ride's GPS trail is its current driver's trail.
--
-- Since 00686 a ride that the system took away from a silent driver keeps the
-- points he sent while it was searching, and when another driver takes it, the
-- ride carries the trails of both. Six functions read the trail without asking
-- whose each point is:
--
--   update_ride_status_v2          path C accepts a trail point near the target as
--                                  proof of arrival. A point of the previous driver
--                                  near the pickup let the new one mark "Llegué"
--                                  from far away and start the wait charge. Its
--                                  recorded_at >= accepted_at filter does not stop
--                                  it: recorded_at is the phone's clock, which can
--                                  run an hour ahead in Cuba.
--   compute_ride_trail_distance_m  the distance complete_ride_and_pay records.
--   calculate_ride_distance        the distance the driver app sends at completion.
--   get_shared_trip_state          the position on the shared tracking link.
--   check_stuck_active_rides       the "driver standing still" stuck-ride alert.
--   admin_get_ride_track           the track the panel draws.
--
-- Each one now keeps only the points of the ride's current driver. A ride with no
-- driver (cancelled while searching) keeps all its points, so the panel still
-- draws them. Measured on 2026-11-20: in 60 days one ride had points of two
-- drivers (79b5d8a9, 2026-11-19), and nothing was charged from them.
-- _ride_gps_departure_at and admin_active_ride_context already filter by driver.
--
-- Patched in place from the live bodies, one guarded replacement each: a body
-- that is neither the expected one nor the patched one stops the migration.
-- Re-running it is a no-op. A copy with Windows line ends patches the same
-- text, without carriage returns.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION pg_temp.patch_trail_fn(p_fn regprocedure, p_old_md5 text, p_new_md5 text,
                                                  p_final_md5 text, p_from text, p_to text)
RETURNS text
LANGUAGE plpgsql
AS $f$
DECLARE
  v_from text := replace(p_from, chr(13), '');
  v_to   text := replace(p_to, chr(13), '');
  v_md5  text;
  v_src  text;
  v_def  text;
BEGIN
  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = p_fn;
  -- Already past this step: this one, or every step of the function, applied.
  IF v_md5 IN (p_new_md5, p_final_md5) THEN
    RETURN 'already';
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00692: % has an unknown body (md5 %), expected %', p_fn, v_md5, p_old_md5;
  END IF;
  IF (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from) <> 1 THEN
    RAISE EXCEPTION '00692: % does not contain the text to replace exactly once', p_fn;
  END IF;
  v_def := pg_get_functiondef(p_fn);
  IF (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 THEN
    RAISE EXCEPTION '00692: the definition of % does not contain the text exactly once', p_fn;
  END IF;
  EXECUTE replace(v_def, v_from, v_to);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = p_fn;
  IF v_md5 IS DISTINCT FROM p_new_md5 THEN
    RAISE EXCEPTION '00692: % ended with md5 %, expected %', p_fn, v_md5, p_new_md5;
  END IF;
  RETURN 'patched';
END
$f$;

-- 1. admin_get_ride_track
SELECT pg_temp.patch_trail_fn('public.admin_get_ride_track(uuid)'::regprocedure,
  '1dd58e5e47e1be44060de1312a42d04d', '838355cb2b5a6b9682c4bcf39da4c3c3', '838355cb2b5a6b9682c4bcf39da4c3c3',
$from1$  WHERE e.ride_id = p_ride_id
  ORDER BY e.recorded_at ASC$from1$,
$to1$  WHERE e.ride_id = p_ride_id
    -- 00692: only the current driver's points (all of them if the ride has no driver).
    AND e.driver_id IS NOT DISTINCT FROM COALESCE((SELECT r.driver_id FROM public.rides r WHERE r.id = p_ride_id), e.driver_id)
  ORDER BY e.recorded_at ASC$to1$);

-- 2. calculate_ride_distance
SELECT pg_temp.patch_trail_fn('public.calculate_ride_distance(uuid)'::regprocedure,
  '02532e947c3b120bb666d52ddaa4400c', 'b3e8adb5970ec1dd3668c0bda235808c', 'b3e8adb5970ec1dd3668c0bda235808c',
$from2$    WHERE ride_id = p_ride_id
      AND location IS NOT NULL$from2$,
$to2$    WHERE ride_id = p_ride_id
      -- 00692: only the current driver's points (all of them if the ride has no driver).
      AND driver_id IS NOT DISTINCT FROM COALESCE((SELECT r.driver_id FROM public.rides r WHERE r.id = p_ride_id), driver_id)
      AND location IS NOT NULL$to2$);

-- 3. check_stuck_active_rides
SELECT pg_temp.patch_trail_fn('public.check_stuck_active_rides()'::regprocedure,
  'bb84304cf98114f9597c8a68f6f0cee5', '7c314cfdbfa1454fa68887b01beb407c', 'f045c051e36ac172b13eb1d78bc655f9',
$from3$      WHERE le.ride_id = v_ride.id
      ORDER BY le.recorded_at DESC, le.id DESC$from3$,
$to3$      WHERE le.ride_id = v_ride.id
        -- 00692: only the current driver's points.
        AND le.driver_id IS NOT DISTINCT FROM COALESCE(v_ride.driver_id, le.driver_id)
      ORDER BY le.recorded_at DESC, le.id DESC$to3$);

-- 4. check_stuck_active_rides
SELECT pg_temp.patch_trail_fn('public.check_stuck_active_rides()'::regprocedure,
  '7c314cfdbfa1454fa68887b01beb407c', 'f045c051e36ac172b13eb1d78bc655f9', 'f045c051e36ac172b13eb1d78bc655f9',
$from4$        WHERE le.ride_id = v_ride.id
          AND le.recorded_at >= v_now - make_interval(secs => v_win_s);$from4$,
$to4$        WHERE le.ride_id = v_ride.id
          AND le.driver_id IS NOT DISTINCT FROM COALESCE(v_ride.driver_id, le.driver_id)
          AND le.recorded_at >= v_now - make_interval(secs => v_win_s);$to4$);

-- 5. compute_ride_trail_distance_m
SELECT pg_temp.patch_trail_fn('public.compute_ride_trail_distance_m(uuid, timestamptz)'::regprocedure,
  '998812627ebecafc302397e20f0f3d6d', '45f4502efae8d6d5cad69af8188bca69', '45f4502efae8d6d5cad69af8188bca69',
$from5$    WHERE ride_id = p_ride_id
      AND recorded_at >= p_since$from5$,
$to5$    WHERE ride_id = p_ride_id
      -- 00692: only the current driver's points (all of them if the ride has no driver).
      AND driver_id IS NOT DISTINCT FROM COALESCE((SELECT r.driver_id FROM public.rides r WHERE r.id = p_ride_id), driver_id)
      AND recorded_at >= p_since$to5$);

-- 6. get_shared_trip_state
SELECT pg_temp.patch_trail_fn('public.get_shared_trip_state(text)'::regprocedure,
  '02cd9bbddd0c4a13477ee015e3a662d0', 'da39d1ed1c135fd9119a73db143981ba', 'da39d1ed1c135fd9119a73db143981ba',
$from6$    WHERE ride_id = r.id
    ORDER BY recorded_at DESC$from6$,
$to6$    WHERE ride_id = r.id
      -- 00692: only the current driver's points (all of them if the ride has no driver).
      AND ride_location_events.driver_id IS NOT DISTINCT FROM COALESCE(r.driver_id, ride_location_events.driver_id)
    ORDER BY recorded_at DESC$to6$);

-- 7. update_ride_status_v2
SELECT pg_temp.patch_trail_fn('public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean)'::regprocedure,
  '1b51ff1040421c99e94c8bff15e2acff', 'e856be9516009c86bb038c0cbb90f4c9', 'e856be9516009c86bb038c0cbb90f4c9',
$from7$  WHERE le.ride_id = p_ride_id
    AND le.recorded_at >= v_trail_since$from7$,
$to7$  WHERE le.ride_id = p_ride_id
    -- 00692: only this driver's points. Since 00686 a ride can keep the points of a
    -- driver it was taken from, and one near the target would prove nothing here.
    AND le.driver_id = v_ride.driver_id
    AND le.recorded_at >= v_trail_since$to7$);

-- Checks
DO $check$
DECLARE
  r record;
  v_md5 text;
  v_len integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.admin_get_ride_track(uuid)', '838355cb2b5a6b9682c4bcf39da4c3c3', 664),
    ('public.calculate_ride_distance(uuid)', 'b3e8adb5970ec1dd3668c0bda235808c', 1048),
    ('public.check_stuck_active_rides()', 'f045c051e36ac172b13eb1d78bc655f9', 9425),
    ('public.compute_ride_trail_distance_m(uuid, timestamptz)', '45f4502efae8d6d5cad69af8188bca69', 1707),
    ('public.get_shared_trip_state(text)', 'da39d1ed1c135fd9119a73db143981ba', 856),
    ('public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean)', 'e856be9516009c86bb038c0cbb90f4c9', 8718)
  ) AS t(sig, md5, len)
  LOOP
    SELECT md5(prosrc), length(prosrc) INTO v_md5, v_len FROM pg_proc WHERE oid = r.sig::regprocedure;
    IF v_md5 IS DISTINCT FROM r.md5 OR v_len IS DISTINCT FROM r.len THEN
      RAISE EXCEPTION '00692 check: % is %/% instead of %/%', r.sig, v_md5, v_len, r.md5, r.len;
    END IF;
  END LOOP;
END
$check$;

DROP FUNCTION pg_temp.patch_trail_fn(regprocedure, text, text, text, text, text);
