-- ============================================================
-- TriciGo — Seed Data
-- ============================================================

-- Service types
INSERT INTO service_type_configs (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, icon_name, is_active, sort_order, per_wait_minute_rate_cup, free_wait_minutes)
VALUES
  ('moto_standard', 'Moto', 'Motorcycle', 300, 280, 25, 1500, 1, 'motorcycle', true, 1, 25, 5),
  ('triciclo_basico', 'Triciclo', 'Tricycle', 400, 400, 35, 2000, 8, 'bicycle', true, 2, 30, 5),
  ('triciclo_premium', 'Triciclo Premium', 'Premium Tricycle', 400, 400, 35, 2000, 8, 'bicycle', false, 3, 30, 5),
  ('triciclo_cargo', 'Triciclo Cargo', 'Tricycle Cargo', 2000, 0, 33, 2000, 0, 'cube', true, 4, 0, 0),
  ('auto_standard', 'Auto', 'Car', 1000, 900, 60, 3500, 4, 'car', true, 5, 50, 5),
  ('auto_confort', 'Confort', 'Comfort', 1800, 1200, 100, 5500, 4, 'car', true, 6, 80, 5);

-- Havana zones (simplified polygons)
INSERT INTO zones (name, type, boundary, surge_multiplier, is_active)
VALUES
  ('Vedado', 'operational', ST_GeomFromText('POLYGON((-82.42 23.12, -82.38 23.12, -82.38 23.14, -82.42 23.14, -82.42 23.12))', 4326), 1.00, true),
  ('Centro Habana', 'operational', ST_GeomFromText('POLYGON((-82.38 23.13, -82.35 23.13, -82.35 23.15, -82.38 23.15, -82.38 23.13))', 4326), 1.00, true),
  ('Habana Vieja', 'surge', ST_GeomFromText('POLYGON((-82.36 23.135, -82.34 23.135, -82.34 23.15, -82.36 23.15, -82.36 23.135))', 4326), 1.20, true),
  ('Miramar', 'operational', ST_GeomFromText('POLYGON((-82.45 23.10, -82.40 23.10, -82.40 23.13, -82.45 23.13, -82.45 23.10))', 4326), 1.00, true);

-- Global pricing rules (4 time bands: Morning 6-12, Afternoon 12-18, Night 18-0, Dawn 0-6)

-- Moto: Morning & Afternoon (1.0x), Night (1.5x), Dawn (2.0x)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'moto_standard', 300, 280, 25, 1500, '06:00', '12:00', true),
  (NULL, 'moto_standard', 300, 280, 25, 1500, '12:00', '18:00', true),
  (NULL, 'moto_standard', 450, 420, 38, 2250, '18:00', '00:00', true),
  (NULL, 'moto_standard', 600, 560, 50, 3000, '00:00', '06:00', true);

-- Triciclo: Morning & Afternoon (1.0x), Night (1.5x), Dawn (2.0x)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'triciclo_basico', 400, 400, 35, 2000, '06:00', '12:00', true),
  (NULL, 'triciclo_basico', 400, 400, 35, 2000, '12:00', '18:00', true),
  (NULL, 'triciclo_basico', 600, 600, 53, 3000, '18:00', '00:00', true),
  (NULL, 'triciclo_basico', 800, 800, 70, 4000, '00:00', '06:00', true);

-- Triciclo Cargo: per hour pricing (per_km=0, per_minute=hourly/60)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'triciclo_cargo', 2000, 0, 33, 2000, '06:00', '12:00', true),
  (NULL, 'triciclo_cargo', 2000, 0, 33, 2000, '12:00', '18:00', true),
  (NULL, 'triciclo_cargo', 3000, 0, 50, 3000, '18:00', '00:00', true),
  (NULL, 'triciclo_cargo', 4000, 0, 67, 4000, '00:00', '06:00', true);

-- Auto Standard: Morning & Afternoon (1.0x), Night (1.5x), Dawn (2.0x)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'auto_standard', 1000, 900, 60, 3500, '06:00', '12:00', true),
  (NULL, 'auto_standard', 1000, 900, 60, 3500, '12:00', '18:00', true),
  (NULL, 'auto_standard', 1500, 1350, 90, 5250, '18:00', '00:00', true),
  (NULL, 'auto_standard', 2000, 1800, 120, 7000, '00:00', '06:00', true);

-- Auto Confort: Morning & Afternoon (1.0x), Night (1.5x), Dawn (2.0x)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'auto_confort', 1800, 1200, 100, 5500, '06:00', '12:00', true),
  (NULL, 'auto_confort', 1800, 1200, 100, 5500, '12:00', '18:00', true),
  (NULL, 'auto_confort', 2700, 1800, 150, 8250, '18:00', '00:00', true),
  (NULL, 'auto_confort', 3600, 2400, 200, 11000, '00:00', '06:00', true);

-- Weather surge config
INSERT INTO platform_config (key, value) VALUES
  ('openweather_api_key', '"YOUR_API_KEY"'),
  ('weather_surge_enabled', 'true'),
  ('weather_last_check', 'null')
ON CONFLICT (key) DO NOTHING;
