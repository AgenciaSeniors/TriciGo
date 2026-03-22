-- Multi-city architecture
CREATE TABLE IF NOT EXISTS cities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'CU',
  timezone TEXT NOT NULL DEFAULT 'America/Havana',
  center_latitude NUMERIC(10,6) NOT NULL,
  center_longitude NUMERIC(10,6) NOT NULL,
  bounds_ne_lat NUMERIC(10,6),
  bounds_ne_lng NUMERIC(10,6),
  bounds_sw_lat NUMERIC(10,6),
  bounds_sw_lng NUMERIC(10,6),
  default_map_zoom INT DEFAULT 12,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cities_select_all" ON cities FOR SELECT USING (true);
CREATE POLICY "cities_admin" ON cities FOR ALL USING (is_admin());

INSERT INTO cities (name, slug, country, timezone, center_latitude, center_longitude, bounds_ne_lat, bounds_ne_lng, bounds_sw_lat, bounds_sw_lng)
VALUES ('La Habana', 'havana', 'CU', 'America/Havana', 23.1136, -82.3666, 23.20, -82.30, 23.05, -82.45)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE rides ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);
ALTER TABLE zones ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);
ALTER TABLE surge_zones ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);

UPDATE rides SET city_id = (SELECT id FROM cities WHERE slug = 'havana') WHERE city_id IS NULL;
UPDATE driver_profiles SET city_id = (SELECT id FROM cities WHERE slug = 'havana') WHERE city_id IS NULL;
UPDATE zones SET city_id = (SELECT id FROM cities WHERE slug = 'havana') WHERE city_id IS NULL;
UPDATE pricing_rules SET city_id = (SELECT id FROM cities WHERE slug = 'havana') WHERE city_id IS NULL;
UPDATE surge_zones SET city_id = (SELECT id FROM cities WHERE slug = 'havana') WHERE city_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_rides_city ON rides(city_id);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_city ON driver_profiles(city_id);
CREATE INDEX IF NOT EXISTS idx_zones_city ON zones(city_id);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_city ON pricing_rules(city_id);
