-- Checks of the rehearsal of 00693. Without the migration T1, T2, T3 and T7 fail.
DO $t$
DECLARE r record;
BEGIN
  -- T1/T2: the backfill puts back what the polygon says, active or not.
  SELECT municipality, province INTO r FROM public.cuba_pois WHERE id = 1;
  IF r.municipality IS DISTINCT FROM 'Plaza de la Revolución' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T1 a drifted place gets its polygon municipality back', r.municipality);
  END IF;
  SELECT municipality, province INTO r FROM public.cuba_pois WHERE id = 4;
  IF r.province IS DISTINCT FROM 'La Habana' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T2 an inactive drifted place gets its polygon province back', r.province);
  END IF;

  -- T3: a sync-style update (source values + the same location) keeps the polygon's values.
  UPDATE public.cuba_pois SET municipality = 'Havana', province = 'Havana', location = location WHERE id = 2;
  SELECT municipality, province INTO r FROM public.cuba_pois WHERE id = 2;
  IF r.municipality IS DISTINCT FROM 'Plaza de la Revolución' OR r.province IS DISTINCT FROM 'La Habana' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T3 the sync no longer overwrites the polygon values', r.municipality || ' / ' || r.province);
  END IF;

  -- T4: outside every polygon, the source value stays (as in 00580), also after a sync update.
  UPDATE public.cuba_pois SET municipality = 'Bauta', location = location WHERE id = 3;
  SELECT municipality INTO r FROM public.cuba_pois WHERE id = 3;
  IF r.municipality IS DISTINCT FROM 'Bauta' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T4 outside the polygons the source value stays', r.municipality);
  END IF;

  -- T5: an insert takes the polygon values.
  INSERT INTO public.cuba_pois (id, name, location, municipality, province) VALUES (5, 'Nuevo', 'P2', 'Havana', 'Havana');
  SELECT municipality, province INTO r FROM public.cuba_pois WHERE id = 5;
  IF r.municipality IS DISTINCT FROM 'Centro Habana' OR r.province IS DISTINCT FROM 'La Habana' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T5 an insert takes the polygon values', r.municipality || ' / ' || r.province);
  END IF;

  -- T6: an edit of municipality alone (no location in the SET list) does not fire the trigger.
  UPDATE public.cuba_pois SET municipality = 'Manual' WHERE id = 2;
  SELECT municipality INTO r FROM public.cuba_pois WHERE id = 2;
  IF r.municipality IS DISTINCT FROM 'Manual' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T6 an edit without location keeps its value', r.municipality);
  END IF;

  -- T7: the trigger body is the one of 00693.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_cuba_pois_admin_area()'::regprocedure)
     <> '5000135d7aae2c84492966230c9d9b5f' THEN
    INSERT INTO rehearsal._t_fail VALUES ('T7 tg_cuba_pois_admin_area has the 00693 body', NULL);
  END IF;
END
$t$;
