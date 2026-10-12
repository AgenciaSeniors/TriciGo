-- 00659: a driver's GPS trail only goes to the rides they drive, and the wait
-- charge counts from when the server received a trail point, not from the time
-- the phone puts on it.
--
-- Measured in prod on 2026-10-12 with the demo accounts, in a rolled-back block:
--
--   1. rl_insert only checks that driver_id is the caller's. A driver could
--      write trail points on any ride id. The rider's app draws those points as
--      the driver's position, and on an active ride they fire the
--      "Conductor cerca" push (check_proximity_notification).
--   2. update_ride_status_v2 falls back to the ride's trail (Path C) when the
--      live coordinates are missing or too far, and sets driver_arrived_at to
--      the oldest qualifying recorded_at. The phone writes recorded_at. A point
--      at the pickup dated 24 minutes back, then "llegué" without coordinates,
--      left driver_arrived_at 24 minutes back: 19 billable minutes, 1,501 CUP at
--      the morning rate of 79 CUP/min. At night (314 CUP/min) that is 5,966 CUP.
--
-- What changes:
--
--   A. ride_location_events.received_at: the server's clock, always, set by a
--      BEFORE INSERT trigger. recorded_at stays the phone's time: the offline
--      buffer replays real fixes, and the trail and the map need them.
--   B. The same trigger drops a point whose ride is not driven by the point's
--      driver_id (RETURN NULL, no error). It drops instead of raising because
--      the app uploads points in batches: one stale point (a ride reassigned
--      while the phone was offline) must not sink the rest of the batch. A
--      dropped row fires no AFTER trigger, so no proximity push either.
--      update_driver_position goes through the same trigger.
--   C. update_ride_status_v2 Path C bills from GREATEST(recorded_at,
--      received_at): never earlier than the server saw the point. Rows written
--      before this migration have no received_at and keep recorded_at
--      (GREATEST skips NULL). Cost: a driver whose arrival was buffered offline
--      gets the wait clock from when the points reached the server, so the
--      rider pays less, never more. The trail still decides whether the driver
--      got there (selection by recorded_at is unchanged).
--   D. anon and authenticated lose the table privileges that no policy uses.
--      The apps only ever inserted (insert, later upsert with ignoreDuplicates,
--      i.e. ON CONFLICT DO NOTHING) and selected.
--
-- Not covered: a modified app can still send made-up live coordinates (Path
-- B.1) and start the wait clock early. That needs evidence the server does not
-- have today (rider confirmation, a pickup code, or the mock-location flag the
-- driver app already reads).

SET lock_timeout = '5s';

-- A. Server receipt time.
ALTER TABLE public.ride_location_events ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE public.ride_location_events ALTER COLUMN received_at SET DEFAULT now();
COMMENT ON COLUMN public.ride_location_events.received_at IS
  '00659: when the server received the point (set by trg_ride_location_events_guard). recorded_at is the phone''s time. Billing uses the later of the two.';

-- A + B. One BEFORE INSERT trigger for every writer, client or RPC.
CREATE OR REPLACE FUNCTION public.tg_ride_location_events_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- The server's clock, whatever the writer sent.
  NEW.received_at := now();
  -- A point belongs to a ride its driver drives. Dropped, not refused: the app
  -- uploads in batches, and one stale point (a ride reassigned while the phone
  -- was offline) must not sink the rest.
  IF NOT EXISTS (
    SELECT 1 FROM public.rides r
    WHERE r.id = NEW.ride_id AND r.driver_id = NEW.driver_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_ride_location_events_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_ride_location_events_guard
  BEFORE INSERT ON public.ride_location_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_location_events_guard();

-- A pasted copy of this file with Windows line ends puts \r in the function
-- body. It runs the same, but its md5 no longer matches git. Rebuild it from
-- the catalog without them.
DO $crlf$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.tg_ride_location_events_guard()'::regprocedure) INTO v_def;
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- C. Path C bills from the later of the two times. Patched in place from the
-- live body (00634's, md5 182eeb57...), and refused on any other body.
DO $patch$
DECLARE
  c_fn constant regprocedure :=
    'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure;
  c_old_md5 constant text := '182eeb5721e458b9976c12d7318f09ac';
  c_new_md5 constant text := '1b51ff1040421c99e94c8bff15e2acff';
  c_sel_old constant text := 'SELECT MIN(le.recorded_at) INTO v_trail_at';
  c_sel_new constant text := 'SELECT MIN(GREATEST(le.recorded_at, le.received_at)) INTO v_trail_at';
  c_cmt_old constant text := E'-- Hora real de llegada, no now(): el cargo por espera sale de\n'
                          || E'      -- (pickup_at - driver_arrived_at) y now() se la inflar\u00eda al pasajero.';
  c_cmt_new constant text := E'-- 00659: bill from when the server received the point, or the\n'
                          || E'      -- phone''s time if later. The phone''s time alone can be backdated,\n'
                          || E'      -- and the wait charge is (pickup_at - driver_arrived_at).';
  v_src text;
  v_md5 text;
  v_def text;
BEGIN
  SELECT prosrc, md5(prosrc) INTO v_src, v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM c_old_md5 THEN
    RAISE EXCEPTION '00659: update_ride_status_v2 is not the body this migration patches (md5 %)', v_md5;
  END IF;
  IF (length(v_src) - length(replace(v_src, c_sel_old, ''))) / length(c_sel_old) <> 1
     OR (length(v_src) - length(replace(v_src, c_cmt_old, ''))) / length(c_cmt_old) <> 1 THEN
    RAISE EXCEPTION '00659: update_ride_status_v2 does not contain each patched text exactly once';
  END IF;
  v_def := pg_get_functiondef(c_fn);
  EXECUTE replace(replace(v_def, c_sel_old, c_sel_new), c_cmt_old, c_cmt_new);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 IS DISTINCT FROM c_new_md5 THEN
    RAISE EXCEPTION '00659: update_ride_status_v2 patched to an unexpected body (md5 %)', v_md5;
  END IF;
END
$patch$;

-- D. Table privileges no policy uses. TRUNCATE skips RLS altogether.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.ride_location_events FROM anon;
REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON public.ride_location_events FROM authenticated;
DO $maintain$
BEGIN
  -- MAINTAIN exists from PG17 (prod); the PG16 rehearsal has no such privilege.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON public.ride_location_events FROM anon, authenticated';
  END IF;
END
$maintain$;

-- Checks. The migration fails rather than report a fix that did not land.
DO $verify$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ride_location_events' AND column_name = 'received_at'
  ) THEN
    RAISE EXCEPTION '00659 check: ride_location_events.received_at is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.ride_location_events'::regclass
      AND tgname = 'trg_ride_location_events_guard'
      AND tgenabled = 'O'
      AND tgfoid = 'public.tg_ride_location_events_guard()'::regprocedure
  ) THEN
    RAISE EXCEPTION '00659 check: trg_ride_location_events_guard is missing or disabled';
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.tg_ride_location_events_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'a6af4796e5d96697a993127b819def6d' THEN
    RAISE EXCEPTION '00659 check: tg_ride_location_events_guard has an unexpected body (md5 %)', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = 'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1b51ff1040421c99e94c8bff15e2acff' THEN
    RAISE EXCEPTION '00659 check: update_ride_status_v2 has an unexpected body (md5 %)', v_md5;
  END IF;

  IF has_table_privilege('anon', 'public.ride_location_events', 'INSERT')
     OR has_table_privilege('anon', 'public.ride_location_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.ride_location_events', 'DELETE')
     OR has_table_privilege('anon', 'public.ride_location_events', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.ride_location_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ride_location_events', 'DELETE')
     OR has_table_privilege('authenticated', 'public.ride_location_events', 'TRUNCATE') THEN
    RAISE EXCEPTION '00659 check: anon or authenticated still holds a write privilege no policy uses';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.ride_location_events', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.ride_location_events', 'SELECT') THEN
    RAISE EXCEPTION '00659 check: authenticated lost INSERT or SELECT, which the driver app needs';
  END IF;
END
$verify$;

RESET lock_timeout;
