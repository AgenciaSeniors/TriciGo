-- 00057: Update pricing to match market rates + add auto_confort service type
-- Reference: competitor app in Havana, route 10.88km/27min

-- 1. Add auto_confort service type
INSERT INTO service_type_configs (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, icon_name, is_active)
VALUES ('auto_confort', 'Confort', 'Comfort', 1600, 1000, 90, 4800, 4, 'car', true)
ON CONFLICT (slug) DO UPDATE SET
  name_es = EXCLUDED.name_es,
  name_en = EXCLUDED.name_en,
  base_fare_cup = EXCLUDED.base_fare_cup,
  per_km_rate_cup = EXCLUDED.per_km_rate_cup,
  per_minute_rate_cup = EXCLUDED.per_minute_rate_cup,
  min_fare_cup = EXCLUDED.min_fare_cup,
  max_passengers = EXCLUDED.max_passengers,
  is_active = EXCLUDED.is_active;

-- 2. Update existing service types with new market-rate pricing
UPDATE service_type_configs SET
  base_fare_cup = 500, per_km_rate_cup = 530, per_minute_rate_cup = 42, min_fare_cup = 2200, is_active = true
WHERE slug = 'triciclo_basico';

UPDATE service_type_configs SET
  base_fare_cup = 300, per_km_rate_cup = 250, per_minute_rate_cup = 25, min_fare_cup = 1400, is_active = true
WHERE slug = 'moto_standard';

UPDATE service_type_configs SET
  base_fare_cup = 900, per_km_rate_cup = 750, per_minute_rate_cup = 55, min_fare_cup = 3000, is_active = true
WHERE slug = 'auto_standard';

-- 3. Delete old pricing rules (they don't have time bands)
DELETE FROM pricing_rules
WHERE service_type IN ('triciclo_basico', 'moto_standard', 'auto_standard', 'auto_confort');

-- 4. Insert new pricing rules with 4 time bands for all 4 active services
-- Moto: base rates (day), 1.5x night, 2.0x dawn
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'moto_standard', 300, 250, 25, 1400, '06:00', '12:00', true),
  (NULL, 'moto_standard', 300, 250, 25, 1400, '12:00', '18:00', true),
  (NULL, 'moto_standard', 450, 375, 38, 2100, '18:00', '00:00', true),
  (NULL, 'moto_standard', 600, 500, 50, 2800, '00:00', '06:00', true);

-- Triciclo: base rates (day), 1.5x night, 2.0x dawn
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'triciclo_basico', 500, 530, 42, 2200, '06:00', '12:00', true),
  (NULL, 'triciclo_basico', 500, 530, 42, 2200, '12:00', '18:00', true),
  (NULL, 'triciclo_basico', 750, 795, 63, 3300, '18:00', '00:00', true),
  (NULL, 'triciclo_basico', 1000, 1060, 84, 4400, '00:00', '06:00', true);

-- Auto Standard: base rates (day), 1.5x night, 2.0x dawn
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'auto_standard', 900, 750, 55, 3000, '06:00', '12:00', true),
  (NULL, 'auto_standard', 900, 750, 55, 3000, '12:00', '18:00', true),
  (NULL, 'auto_standard', 1350, 1125, 83, 4500, '18:00', '00:00', true),
  (NULL, 'auto_standard', 1800, 1500, 110, 6000, '00:00', '06:00', true);

-- Auto Confort: base rates (day), 1.5x night, 2.0x dawn
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'auto_confort', 1600, 1000, 90, 4800, '06:00', '12:00', true),
  (NULL, 'auto_confort', 1600, 1000, 90, 4800, '12:00', '18:00', true),
  (NULL, 'auto_confort', 2400, 1500, 135, 7200, '18:00', '00:00', true),
  (NULL, 'auto_confort', 3200, 2000, 180, 9600, '00:00', '06:00', true);
