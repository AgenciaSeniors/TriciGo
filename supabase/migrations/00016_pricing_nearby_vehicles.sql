-- ============================================================
-- Migration 00016: Driver Custom Pricing, Nearby Vehicles RPC,
--                  Dynamic Surge, Realtime for driver_profiles
-- ============================================================

-- 1A. Add custom_per_km_rate to driver_profiles
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS custom_per_km_rate INTEGER DEFAULT NULL;

COMMENT ON COLUMN driver_profiles.custom_per_km_rate
  IS 'Driver custom per-km rate in TRC centavos. NULL = use default from service_type_configs.';

-- 1B. Add platform config entries for pricing caps
INSERT INTO platform_config (key, value) VALUES
  ('max_driver_rate_multiplier', '2.0'),
  ('default_per_km_rate_trc', '100')
ON CONFLICT (key) DO NOTHING;

-- 1C. Add driver_custom_rate_trc to rides (for audit trail)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS driver_custom_rate_trc INTEGER DEFAULT NULL;

-- 1D. find_nearby_vehicles RPC — lightweight query for map display
CREATE OR REPLACE FUNCTION find_nearby_vehicles(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_vehicle_type TEXT DEFAULT NULL,
  p_radius_m INTEGER DEFAULT 5000,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  driver_profile_id UUID,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  vehicle_type TEXT,
  custom_per_km_rate INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_center GEOGRAPHY;
BEGIN
  v_center := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  RETURN QUERY
  SELECT
    dp.id AS driver_profile_id,
    ST_Y(dp.current_location::geometry) AS latitude,
    ST_X(dp.current_location::geometry) AS longitude,
    dp.current_heading::DOUBLE PRECISION AS heading,
    v.type::TEXT AS vehicle_type,
    dp.custom_per_km_rate
  FROM driver_profiles dp
  INNER JOIN vehicles v
    ON v.driver_id = dp.id
    AND v.is_active = true
  WHERE dp.is_online = true
    AND dp.status = 'approved'
    AND dp.current_location IS NOT NULL
    AND ST_DWithin(dp.current_location, v_center, p_radius_m)
    AND (p_vehicle_type IS NULL OR v.type::TEXT = p_vehicle_type)
    AND NOT EXISTS (
      SELECT 1 FROM rides r
      WHERE r.driver_id = dp.id
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
    )
  ORDER BY ST_Distance(dp.current_location, v_center)
  LIMIT p_limit;
END;
$$;

-- 1E. calculate_dynamic_surge RPC — supply/demand + time-based
CREATE OR REPLACE FUNCTION calculate_dynamic_surge(
  p_zone_id UUID DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL,
  p_radius_m INTEGER DEFAULT 3000
)
RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_searching_count INTEGER;
  v_online_drivers INTEGER;
  v_demand_ratio NUMERIC;
  v_time_surge NUMERIC := 1.0;
  v_demand_surge NUMERIC := 1.0;
  v_center GEOGRAPHY;
BEGIN
  -- Time-based surge: check surge_zones table
  IF p_zone_id IS NOT NULL THEN
    SELECT COALESCE(MAX(sz.multiplier), 1.0) INTO v_time_surge
    FROM surge_zones sz
    WHERE sz.zone_id = p_zone_id
      AND sz.active = true
      AND (sz.starts_at IS NULL OR sz.starts_at <= NOW())
      AND (sz.ends_at IS NULL OR sz.ends_at >= NOW());
  END IF;

  -- Supply/demand surge: ratio of searching rides to online drivers
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    v_center := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

    SELECT COUNT(*) INTO v_searching_count
    FROM rides r
    WHERE r.status = 'searching'
      AND r.pickup_location IS NOT NULL
      AND ST_DWithin(r.pickup_location, v_center, p_radius_m);

    SELECT COUNT(*) INTO v_online_drivers
    FROM driver_profiles dp
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.current_location IS NOT NULL
      AND ST_DWithin(dp.current_location, v_center, p_radius_m);

    IF v_online_drivers > 0 THEN
      v_demand_ratio := v_searching_count::NUMERIC / v_online_drivers::NUMERIC;
      -- Map ratio to multiplier: 0-1 = 1.0x, 1-2 = 1.2x, 2-3 = 1.5x, 3+ = capped at 2.0x
      v_demand_surge := CASE
        WHEN v_demand_ratio <= 1.0 THEN 1.0
        WHEN v_demand_ratio <= 2.0 THEN 1.0 + (v_demand_ratio - 1.0) * 0.2
        WHEN v_demand_ratio <= 3.0 THEN 1.2 + (v_demand_ratio - 2.0) * 0.3
        ELSE LEAST(2.0, 1.5 + (v_demand_ratio - 3.0) * 0.1)
      END;
    ELSIF v_searching_count > 0 THEN
      v_demand_surge := 2.0; -- No drivers available, max surge
    END IF;
  END IF;

  -- Highest multiplier wins
  RETURN GREATEST(v_time_surge, v_demand_surge);
END;
$$;

-- 1F. Enable Realtime for driver_profiles (for live vehicle positions on map)
DO $$
BEGIN
  -- Only add if not already in publication
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'driver_profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE driver_profiles;
  END IF;
END;
$$;

-- Grant execute on new functions
GRANT EXECUTE ON FUNCTION find_nearby_vehicles TO anon, authenticated;
GRANT EXECUTE ON FUNCTION calculate_dynamic_surge TO anon, authenticated;
