-- 00693: the weekly POI sync no longer overwrites the municipality and province that 00580 takes
-- from the admin polygons (QA round 4, R4-01).
--
-- What happened: `bulk_upsert_pois` writes `municipality = COALESCE(s.municipality, p.municipality)`
-- with the source's value (Overture says "Havana") and rewrites `location` with the same point. The
-- 00580 trigger fires (location is in the SET list) but returned early when the location did not
-- change, so the source's value stayed. Measured in production on 2026-11-20: 13,530 of 111,136
-- places (7,106 of 19,702 active) had a municipality or province different from their polygon, and
-- 792 active ones said "Havana". The rider sees it in search ("Reparto Bahia · Havana, La Habana").
--
-- Fix:
--   1. The trigger skips only when none of location, municipality and province changed. A sync
--      update now recomputes from the polygon. An admin edit that sets municipality without
--      location does not fire the trigger (UPDATE OF location), so a manual value still sticks.
--      Only the function body changes: no lock on cuba_pois.
--   2. Backfill: every place inside a polygon gets the polygon's municipality and province.
--
-- Applying in production: the function first (instant), then the backfill by id ranges of about
-- 2,000 rows (CLAUDE.md, "Aplicar migraciones pesadas por MCP"): each updated row costs ~2 ms over
-- the 20 indexes of cuba_pois, and a long transaction would hold the row locks that
-- `record_poi_pick` and the rides trigger need.

-- 1. Trigger body. Refuse to replace a body this migration does not know.
DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.tg_cuba_pois_admin_area()'::regprocedure;
  IF v_md5 NOT IN ('6db9d0f1f8c9744e4c99d085fd4a43f3',   -- 00580
                   '5000135d7aae2c84492966230c9d9b5f') THEN -- 00693
    RAISE EXCEPTION '00693: unknown body of tg_cuba_pois_admin_area (md5 %)', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_admin_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_mun text; v_prov text;
BEGIN
  -- 00693: skip only when nothing the polygon decides was written. The weekly sync rewrites
  -- municipality and province with the source's value and the same location.
  IF TG_OP = 'UPDATE'
     AND NEW.location::text = OLD.location::text
     AND NEW.municipality IS NOT DISTINCT FROM OLD.municipality
     AND NEW.province IS NOT DISTINCT FROM OLD.province THEN
    RETURN NEW;
  END IF;
  SELECT municipality, province INTO v_mun, v_prov FROM public._poi_admin_area(NEW.location);
  NEW.municipality := COALESCE(v_mun, NEW.municipality);
  NEW.province     := COALESCE(v_prov, NEW.province);
  RETURN NEW;
END $function$;

-- 2. Backfill. Rows outside every polygon keep what they have, as in 00580.
UPDATE public.cuba_pois p
   SET municipality = COALESCE(x.municipality, p.municipality),
       province     = COALESCE(x.province, p.province)
  FROM public.cuba_pois q
  CROSS JOIN LATERAL public._poi_admin_area(q.location) x
 WHERE q.id = p.id
   AND (   (x.municipality IS NOT NULL AND p.municipality IS DISTINCT FROM x.municipality)
        OR (x.province IS NOT NULL AND p.province IS DISTINCT FROM x.province));
