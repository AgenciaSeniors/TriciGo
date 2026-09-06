-- ============================================================================
-- Migration 00580: official municipality / province on cuba_pois (spec §4.6)
-- 759 distinct municipality strings and 200+ province strings ("FL", "TX",
-- "Матанзас", "City of Havana") among 19,939 active rows — the sources copy
-- whatever free text they carry. 00545 fixed street_intersections the same
-- way; this derives both from cuba_admin_areas by point-in-polygon, on
-- INSERT / UPDATE OF location, and backfills the existing rows in batches.
-- Rehearsed on supabase/tests/poi/ (T6a–T6g); idempotent.
-- ============================================================================
CREATE OR REPLACE FUNCTION public._poi_admin_area(p_point geography, OUT municipality text, OUT province text)
LANGUAGE sql STABLE SET search_path TO 'public','extensions','pg_catalog' AS $function$
  SELECT
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 6 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1),
    (SELECT a.name_es FROM public.cuba_admin_areas a
      WHERE a.admin_level = 4 AND a.geom && (p_point::geometry) AND ST_Contains(a.geom, p_point::geometry) LIMIT 1);
$function$;
COMMENT ON FUNCTION public._poi_admin_area(geography) IS '00580: official (municipality, province) of a point from cuba_admin_areas; NULL when outside every polygon (coast / sea) so the caller keeps whatever it had.';

CREATE OR REPLACE FUNCTION public.tg_cuba_pois_admin_area() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public','extensions','pg_catalog' AS $function$
DECLARE v_mun text; v_prov text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.location::text = OLD.location::text THEN RETURN NEW; END IF;
  SELECT municipality, province INTO v_mun, v_prov FROM public._poi_admin_area(NEW.location);
  NEW.municipality := COALESCE(v_mun, NEW.municipality);
  NEW.province     := COALESCE(v_prov, NEW.province);
  RETURN NEW;
END $function$;
DROP TRIGGER IF EXISTS trg_cuba_pois_admin_area ON public.cuba_pois;
CREATE TRIGGER trg_cuba_pois_admin_area BEFORE INSERT OR UPDATE OF location ON public.cuba_pois
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuba_pois_admin_area();

-- Backfill, batched by id (20k rows per chunk) — one statement over 110k rows
-- with two point-in-polygon lookups each exceeds the session timeout.
-- Only active rows; the UPDATE touches municipality/province, not location,
-- so the trigger above does not fire (the dictionary trigger does — a harmless
-- rebuild of the chunk's rows, once).
SET statement_timeout = 0;
DO $backfill$
DECLARE c_chunk CONSTANT bigint := 20000; v_max bigint; v_from bigint := 0; v_changed bigint; v_total bigint := 0;
BEGIN
  SELECT COALESCE(max(id), 0) INTO v_max FROM public.cuba_pois;
  WHILE v_from <= v_max LOOP
    WITH target AS (
      SELECT p.id, (public._poi_admin_area(p.location)).*
      FROM public.cuba_pois p WHERE p.is_active AND p.id >= v_from AND p.id < v_from + c_chunk)
    UPDATE public.cuba_pois s
       SET municipality = COALESCE(t.municipality, s.municipality),
           province     = COALESCE(t.province, s.province)
      FROM target t WHERE s.id = t.id
       AND (s.municipality IS DISTINCT FROM COALESCE(t.municipality, s.municipality)
         OR s.province     IS DISTINCT FROM COALESCE(t.province, s.province));
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_total := v_total + v_changed; v_from := v_from + c_chunk;
  END LOOP;
  RAISE NOTICE '00580: % active POIs got their official municipality/province', v_total;
END $backfill$;
ANALYZE public.cuba_pois;
RESET statement_timeout;
