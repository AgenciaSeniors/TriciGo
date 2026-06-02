-- 00369 — get_offline_region_for_point (dynamic offline map regions).
--
-- Powers nationwide offline maps: given the user's GPS, return the grid
-- cell to download as a Mapbox offline pack. The cell is a fixed ~0.12°
-- (~13 km) square (stable, dedup-friendly key) CLIPPED to the actual
-- extent of street_intersections inside it — so we never download empty
-- countryside, and rural cells with no streets return 0 rows (the client
-- then downloads nothing and relies on online/ambient cache).
--
-- Why a grid instead of the municipality field: street_intersections.
-- municipality is dirty (500 distinct values, NULLs, spans 0.00°–0.55°),
-- unusable as a clean pack key. The grid gives uniform, predictable packs
-- that let the client budget against Mapbox's ~6000 tiles/device ceiling.
--
-- Reuses the spatial pattern of find_nearby_vehicles (00016) and the
-- street_intersections GIST index on intersection_point (00088).

CREATE OR REPLACE FUNCTION public.get_offline_region_for_point(
  p_lat      double precision,
  p_lng      double precision,
  p_grid_deg double precision DEFAULT 0.12
)
RETURNS TABLE (
  cell_key text,
  sw_lng   double precision,
  sw_lat   double precision,
  ne_lng   double precision,
  ne_lat   double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_lat_idx     integer;
  v_lng_idx     integer;
  v_cell_sw_lng double precision;
  v_cell_sw_lat double precision;
  v_cell_ne_lng double precision;
  v_cell_ne_lat double precision;
  v_env         geography;
  v_ext         geometry;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR p_grid_deg IS NULL OR p_grid_deg <= 0 THEN
    RETURN;
  END IF;

  -- Snap to grid cell (same math as gridCellKey in @tricigo/utils).
  v_lat_idx := floor(p_lat / p_grid_deg);
  v_lng_idx := floor(p_lng / p_grid_deg);
  v_cell_sw_lng := v_lng_idx * p_grid_deg;
  v_cell_sw_lat := v_lat_idx * p_grid_deg;
  v_cell_ne_lng := v_cell_sw_lng + p_grid_deg;
  v_cell_ne_lat := v_cell_sw_lat + p_grid_deg;

  v_env := ST_MakeEnvelope(v_cell_sw_lng, v_cell_sw_lat, v_cell_ne_lng, v_cell_ne_lat, 4326)::geography;

  -- Bounding box of streets inside the cell. `&&` uses the GIST index.
  SELECT ST_Extent(si.intersection_point::geometry)
    INTO v_ext
  FROM street_intersections si
  WHERE si.intersection_point && v_env;

  -- No streets in this cell → nothing to download.
  IF v_ext IS NULL THEN
    RETURN;
  END IF;

  -- Return the street extent clipped to the cell (never exceed the grid cell).
  RETURN QUERY SELECT
    'cell_' || v_lat_idx::text || '_' || v_lng_idx::text,
    GREATEST(ST_XMin(v_ext), v_cell_sw_lng),
    GREATEST(ST_YMin(v_ext), v_cell_sw_lat),
    LEAST(ST_XMax(v_ext), v_cell_ne_lng),
    LEAST(ST_YMax(v_ext), v_cell_ne_lat);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_offline_region_for_point(double precision, double precision, double precision)
  TO authenticated, anon;

COMMENT ON FUNCTION public.get_offline_region_for_point(double precision, double precision, double precision) IS
  '00369 — returns the ~0.12° grid cell (clipped to street extent) to download as a Mapbox offline pack for the given point; 0 rows if no streets nearby.';
