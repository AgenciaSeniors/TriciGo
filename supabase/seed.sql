-- ============================================================
-- TriciGo — Seed Data
-- ============================================================

-- Service types
INSERT INTO service_type_configs (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, icon_name, is_active)
VALUES
  ('triciclo_basico', 'Triciclo Básico', 'Basic Tricycle', 2000, 500, 100, 2500, 2, 'bicycle', true),
  ('triciclo_premium', 'Triciclo Premium', 'Premium Tricycle', 3500, 800, 150, 4000, 2, 'bicycle', false),
  ('moto_standard', 'Moto', 'Motorcycle', 3000, 600, 120, 3500, 1, 'motorcycle', false),
  ('auto_standard', 'Auto', 'Car', 5000, 1000, 200, 6000, 4, 'car', false);

-- Havana zones (simplified polygons)
INSERT INTO zones (name, type, boundary, surge_multiplier, is_active)
VALUES
  ('Vedado', 'operational', ST_GeomFromText('POLYGON((-82.42 23.12, -82.38 23.12, -82.38 23.14, -82.42 23.14, -82.42 23.12))', 4326), 1.00, true),
  ('Centro Habana', 'operational', ST_GeomFromText('POLYGON((-82.38 23.13, -82.35 23.13, -82.35 23.15, -82.38 23.15, -82.38 23.13))', 4326), 1.00, true),
  ('Habana Vieja', 'surge', ST_GeomFromText('POLYGON((-82.36 23.135, -82.34 23.135, -82.34 23.15, -82.36 23.15, -82.36 23.135))', 4326), 1.20, true),
  ('Miramar', 'operational', ST_GeomFromText('POLYGON((-82.45 23.10, -82.40 23.10, -82.40 23.13, -82.45 23.13, -82.45 23.10))', 4326), 1.00, true);

-- Global pricing rules
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, is_active)
VALUES
  (NULL, 'triciclo_basico', 2000, 500, 100, 2500, true),
  (NULL, 'moto_standard', 3000, 600, 120, 3500, true),
  (NULL, 'auto_standard', 5000, 1000, 200, 6000, true);
