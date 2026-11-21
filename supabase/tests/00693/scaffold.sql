-- Scaffold of the rehearsal of migration 00693: cuba_pois with its admin-area trigger as in
-- production (2026-11-20). The trigger function is the live body (md5 checked below).
-- _poi_admin_area is a stand-in: production does a point-in-polygon lookup on cuba_admin_areas
-- (PostGIS); here the location is text and the stand-in maps a few fixed points. The migration
-- only changes the trigger body and runs a backfill that calls _poi_admin_area, so the lookup
-- itself is not under test.
SET client_min_messages = warning;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
GRANT CREATE, USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

SET ROLE postgres;

CREATE TABLE public.cuba_pois (
  id bigint PRIMARY KEY,
  name text,
  location text NOT NULL,
  municipality text,
  province text,
  is_active boolean NOT NULL DEFAULT true
);

-- Stand-in for the polygon lookup: 'P1' is in Plaza de la Revolución, 'P2' in Centro Habana,
-- anything else is outside every polygon.
CREATE FUNCTION public._poi_admin_area(p_point text, OUT municipality text, OUT province text)
 RETURNS record
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE p_point WHEN 'P1' THEN 'Plaza de la Revolución' WHEN 'P2' THEN 'Centro Habana' END,
         CASE WHEN p_point IN ('P1', 'P2') THEN 'La Habana' END;
$function$;

-- Live body (production, 2026-11-20).
CREATE OR REPLACE FUNCTION public.tg_cuba_pois_admin_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_mun text; v_prov text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.location::text = OLD.location::text THEN RETURN NEW; END IF;
  SELECT municipality, province INTO v_mun, v_prov FROM public._poi_admin_area(NEW.location);
  NEW.municipality := COALESCE(v_mun, NEW.municipality);
  NEW.province     := COALESCE(v_prov, NEW.province);
  RETURN NEW;
END $function$;

CREATE TRIGGER trg_cuba_pois_admin_area BEFORE INSERT OR UPDATE OF location ON public.cuba_pois
  FOR EACH ROW EXECUTE FUNCTION public.tg_cuba_pois_admin_area();

DO $live$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_cuba_pois_admin_area()'::regprocedure)
     <> '6db9d0f1f8c9744e4c99d085fd4a43f3' THEN
    RAISE EXCEPTION 'scaffold: tg_cuba_pois_admin_area is not the live body';
  END IF;
END
$live$;

-- Places. They are inserted through the trigger and then drift the way the weekly sync left them:
-- a write of municipality/province without location does not fire the trigger.
INSERT INTO public.cuba_pois (id, name, location, municipality, province, is_active) VALUES
  (1, 'Reparto Bahia', 'P1', NULL, NULL, true),
  (2, 'Hotel', 'P1', NULL, NULL, true),
  (3, 'Fuera', 'OUT', 'Havana', 'Havana', true),
  (4, 'Inactiva', 'P2', NULL, NULL, false);
UPDATE public.cuba_pois SET municipality = 'Havana' WHERE id = 1;
UPDATE public.cuba_pois SET province = 'Ciudad de La Habana' WHERE id = 4;

RESET ROLE;
