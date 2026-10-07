-- Scaffold for the 00633 rehearsal: the LIVE bodies (read from prod on
-- 2026-10-07) of _waypoint_pricing (00386/00387), recalc_ride_estimate_with_waypoints
-- and tg_recalc_fare_on_waypoint_change, the LIVE trigger on ride_waypoints, and
-- the columns they read. PostGIS lives in public, as in prod. A NON-superuser
-- role (prod: postgres) owns everything; run.sh applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

-- service_type_configs: readable by every client, as in prod.
CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY,
  per_km_rate_cup integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.service_type_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY stc_read ON public.service_type_configs FOR SELECT USING (true);
GRANT SELECT ON public.service_type_configs TO anon, authenticated, service_role;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, commission_percent numeric);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status public.ride_status NOT NULL DEFAULT 'searching',
  service_type text NOT NULL REFERENCES public.service_type_configs(slug),
  pickup_location geography(Point, 4326) NOT NULL,
  dropoff_location geography(Point, 4326) NOT NULL,
  surge_multiplier numeric NOT NULL DEFAULT 1,
  driver_custom_rate_cup integer,
  corporate_account_id uuid,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_fare_trc integer,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  estimated_duration_s integer NOT NULL DEFAULT 0
);
CREATE TABLE public.ride_pricing_snapshots (
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  snapshot_type text NOT NULL,
  distance_m integer, duration_s integer,
  subtotal integer, total integer, pre_waypoints_total integer,
  commission_amount integer,
  UNIQUE (ride_id, snapshot_type)
);
CREATE TABLE public.ride_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  sort_order integer NOT NULL,
  location geography(Point, 4326) NOT NULL,
  address text
);

CREATE OR REPLACE FUNCTION public._waypoint_pricing(p_ride_id uuid, p_extra_lat double precision DEFAULT NULL::double precision, p_extra_lng double precision DEFAULT NULL::double precision)
 RETURNS TABLE(path_road_m integer, extra_road_m integer, surcharge_cup integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride       rides%ROWTYPE;
  v_direct_m   numeric;
  v_path_m     numeric;
  v_extra_road numeric;
  v_per_km     numeric;
  v_surge      numeric;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  v_surge := COALESCE(NULLIF(v_ride.surge_multiplier, 0), 1.0);

  v_direct_m := ST_Length(
    ST_MakeLine(v_ride.pickup_location::geometry, v_ride.dropoff_location::geometry)::geography
  );

  WITH pts AS (
    SELECT v_ride.pickup_location::geometry AS geom, 0 AS ord
    UNION ALL
    SELECT w.location::geometry, w.sort_order + 1
      FROM ride_waypoints w WHERE w.ride_id = p_ride_id
    UNION ALL
    SELECT ST_SetSRID(ST_MakePoint(p_extra_lng, p_extra_lat), 4326), 9000
      WHERE p_extra_lat IS NOT NULL AND p_extra_lng IS NOT NULL
    UNION ALL
    SELECT v_ride.dropoff_location::geometry, 9999
  )
  SELECT ST_Length(ST_MakeLine(geom ORDER BY ord)::geography) INTO v_path_m FROM pts;

  IF v_path_m IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  v_extra_road := GREATEST(v_path_m - v_direct_m, 0) * 1.3;

  v_per_km := COALESCE(
    v_ride.driver_custom_rate_cup,
    (SELECT per_km_rate_cup FROM service_type_configs
       WHERE slug = v_ride.service_type AND is_active = true LIMIT 1)
  );
  IF v_per_km IS NULL THEN
    RETURN QUERY SELECT ROUND(v_path_m * 1.3)::int, ROUND(v_extra_road)::int, 0; RETURN;
  END IF;

  RETURN QUERY SELECT
    ROUND(v_path_m * 1.3)::int,
    ROUND(v_extra_road)::int,
    ROUND(v_extra_road / 1000.0 * v_per_km * v_surge)::int;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.recalc_ride_estimate_with_waypoints(p_ride_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride                 rides%ROWTYPE;
  v_snap                 ride_pricing_snapshots%ROWTYPE;
  v_path_road_m          int;
  v_extra_road_m         int;
  v_surcharge            int;
  v_base                 int;
  v_new_total            int;
  v_dur_s                int;
  v_commission_rate      numeric;
  v_corp_commission_rate numeric;
  v_commission_amount    int;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_ride.status NOT IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  ) THEN RETURN; END IF;

  SELECT path_road_m, extra_road_m, surcharge_cup
    INTO v_path_road_m, v_extra_road_m, v_surcharge
  FROM public._waypoint_pricing(p_ride_id);

  IF v_path_road_m IS NULL OR v_path_road_m < 100 THEN RETURN; END IF;

  v_dur_s := ROUND((v_path_road_m / 1000.0) / 25.0 * 3600.0)::int;

  SELECT * INTO v_snap FROM ride_pricing_snapshots
   WHERE ride_id = p_ride_id AND snapshot_type = 'estimate' LIMIT 1;

  IF FOUND THEN
    v_base := COALESCE(v_snap.pre_waypoints_total, v_snap.total);
    v_new_total := v_base + v_surcharge;

    SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
      FROM platform_config WHERE key = 'commission_rate';
    v_commission_rate := COALESCE(v_commission_rate, 0.15);
    IF v_ride.corporate_account_id IS NOT NULL THEN
      SELECT commission_percent / 100.0 INTO v_corp_commission_rate
        FROM corporate_accounts WHERE id = v_ride.corporate_account_id;
    END IF;
    IF v_corp_commission_rate IS NOT NULL AND v_corp_commission_rate < v_commission_rate THEN
      v_commission_amount := ROUND(v_new_total * v_corp_commission_rate)::int;
    ELSE
      v_commission_amount := ROUND(v_new_total * v_commission_rate)::int;
    END IF;

    UPDATE ride_pricing_snapshots SET
      pre_waypoints_total = COALESCE(pre_waypoints_total, total),
      distance_m          = v_path_road_m,
      duration_s          = v_dur_s,
      subtotal            = v_new_total,
      total               = v_new_total,
      commission_amount   = v_commission_amount
    WHERE ride_id = p_ride_id AND snapshot_type = 'estimate';
  ELSE
    v_base := COALESCE(v_ride.estimated_fare_cup, 0);
    v_new_total := v_base + v_surcharge;
  END IF;

  UPDATE rides SET
    estimated_distance_m = v_path_road_m,
    estimated_duration_s = v_dur_s,
    estimated_fare_cup   = v_new_total,
    estimated_fare_trc   = v_new_total
  WHERE id = p_ride_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_recalc_fare_on_waypoint_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_ride_id uuid;
BEGIN
  v_ride_id := COALESCE(NEW.ride_id, OLD.ride_id);
  PERFORM public.recalc_ride_estimate_with_waypoints(v_ride_id);
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_recalc_fare_on_waypoint_change failed for ride %: % %',
    v_ride_id, SQLSTATE, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$
;

CREATE TRIGGER trg_recalc_fare_on_waypoint_change AFTER INSERT OR DELETE OR UPDATE ON public.ride_waypoints FOR EACH ROW EXECUTE FUNCTION tg_recalc_fare_on_waypoint_change();

-- Prod's per-km rates of service_type_configs on 2026-10-07.
INSERT INTO public.service_type_configs (slug, per_km_rate_cup, is_active) VALUES
  ('auto_standard', 919, true), ('auto_confort', 1272, true), ('triciclo_basico', 398, true),
  ('moto_standard', 320, true), ('mensajeria', 396, true), ('triciclo_premium', 478, false);
INSERT INTO public.platform_config (key, value) VALUES ('commission_rate', '0.15');

RESET ROLE;
