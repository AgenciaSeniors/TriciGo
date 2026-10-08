-- 00646: two operations alert e-mails stop pasting user text into their HTML as markup.
--
-- check_stuck_active_rides (00538) and notify_dead_driver_alert (00542) build the
-- e-mail body in SQL and send it to the operations inbox as raw HTML (send-email's
-- legacy path). They pasted the rider's and the driver's names, the driver's phone
-- and the pickup and dropoff addresses as they are. Names are written by their
-- owners and addresses by the rider, or copied from POI names that come from OSM,
-- Overture and Foursquare (two active POIs already carry "->"). A rider named
-- '<a href="https://evil.example">Ver viaje</a>' put a working link in an alert
-- sent from noreply@tricigo.com to the people who run the platform.
--
-- Each value now goes through public._html_escape (00628), as
-- notify_support_waiting_rides already does. The rest of each body is unchanged:
-- patched in place on the live body, which must be the one this file was written
-- against (md5 below).
--
-- Rehearsal: supabase/tests/00646/run.sh (local Postgres 16 + PostGIS, the live bodies).

-- 0. The escape helper this file relies on ----------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public._html_escape(text)') IS NULL THEN
    RAISE EXCEPTION '00646: public._html_escape(text) is missing (00628)';
  END IF;
  IF public._html_escape('<a href="x">O''Neil & co</a>') <> '&lt;a href=&quot;x&quot;&gt;O&#39;Neil &amp; co&lt;/a&gt;' THEN
    RAISE EXCEPTION '00646: public._html_escape does not escape as expected';
  END IF;
END
$guard$;

-- 1. Patch both bodies ---------------------------------------------------------------
DO $patch$
DECLARE
  r record;
  v_def text;
  v_md5 text;
  i integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.notify_dead_driver_alert()'::regprocedure,
       'aa6a768cbd67d7b2cd7bfa4e135875f3', '7dd81bf18992f378a8886ce6a35cc95a',
       ARRAY[
         'COALESCE(v_a.driver_name, ''—'') || '' '' || COALESCE(v_a.driver_phone, '''')',
         'COALESCE(v_a.customer_name, ''—'')',
         'COALESCE(v_a.pickup_address, ''—'') || '' → '' || COALESCE(v_a.dropoff_address, ''—'')'
       ],
       ARRAY[
         'public._html_escape(COALESCE(v_a.driver_name, ''—'')) || '' '' || public._html_escape(v_a.driver_phone)',
         'public._html_escape(COALESCE(v_a.customer_name, ''—''))',
         'public._html_escape(COALESCE(v_a.pickup_address, ''—'')) || '' → '' || public._html_escape(COALESCE(v_a.dropoff_address, ''—''))'
       ]),
      ('public.check_stuck_active_rides()'::regprocedure,
       '8478bba2e479523f4d52855adf7454ca', 'bb84304cf98114f9597c8a68f6f0cee5',
       ARRAY[
         'COALESCE(v_customer, ''—'')',
         'COALESCE(v_driver_name, ''—'') || '' '' || COALESCE(v_driver_tel, '''')',
         'COALESCE(v_ride.pickup_address, ''—'')',
         'COALESCE(v_ride.dropoff_address, ''—'')'
       ],
       ARRAY[
         'public._html_escape(COALESCE(v_customer, ''—''))',
         'public._html_escape(COALESCE(v_driver_name, ''—'')) || '' '' || public._html_escape(v_driver_tel)',
         'public._html_escape(COALESCE(v_ride.pickup_address, ''—''))',
         'public._html_escape(COALESCE(v_ride.dropoff_address, ''—''))'
       ])
    ) AS t(fn, old_md5, new_md5, olds, news)
  LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn;
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 IS DISTINCT FROM r.old_md5 THEN
      RAISE EXCEPTION '00646: unexpected body of % (md5 %): not patched', r.fn, v_md5;
    END IF;
    v_def := pg_get_functiondef(r.fn);
    FOR i IN 1 .. cardinality(r.olds) LOOP
      IF (length(v_def) - length(replace(v_def, r.olds[i], ''))) / length(r.olds[i]) <> 1 THEN
        RAISE EXCEPTION '00646: % does not carry % exactly once', r.fn, r.olds[i];
      END IF;
      v_def := replace(v_def, r.olds[i], r.news[i]);
    END LOOP;
    EXECUTE v_def;
  END LOOP;
END
$patch$;

-- 2. Check the result ------------------------------------------------------------------
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.notify_dead_driver_alert()'::regprocedure) <> '7dd81bf18992f378a8886ce6a35cc95a' THEN
    RAISE EXCEPTION '00646: notify_dead_driver_alert is not the patched body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.check_stuck_active_rides()'::regprocedure) <> 'bb84304cf98114f9597c8a68f6f0cee5' THEN
    RAISE EXCEPTION '00646: check_stuck_active_rides is not the patched body';
  END IF;
END
$check$;
