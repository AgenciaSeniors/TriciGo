-- ============================================================
-- Migration: Add Triciclo Cargo mode + sort_order + ride_mode
-- ============================================================

-- 1. Add sort_order to service_type_configs
ALTER TABLE service_type_configs ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- 2. Set display order: Moto -> Triciclo -> Auto -> Confort
UPDATE service_type_configs SET sort_order = 1 WHERE slug = 'moto_standard';
UPDATE service_type_configs SET sort_order = 2 WHERE slug = 'triciclo_basico';
UPDATE service_type_configs SET sort_order = 3 WHERE slug = 'triciclo_premium';
UPDATE service_type_configs SET sort_order = 5 WHERE slug = 'auto_standard';
UPDATE service_type_configs SET sort_order = 6 WHERE slug = 'auto_confort';
UPDATE service_type_configs SET sort_order = 99 WHERE slug = 'mensajeria';

-- 3. Insert triciclo_cargo service type
INSERT INTO service_type_configs (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers, icon_name, is_active, sort_order)
VALUES ('triciclo_cargo', 'Triciclo Cargo', 'Tricycle Cargo', 2000, 0, 33, 2000, 0, 'cube', true, 4)
ON CONFLICT (slug) DO NOTHING;

-- 4. Add ride_mode and estimated_duration_hours to rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS ride_mode TEXT NOT NULL DEFAULT 'passenger';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS estimated_duration_hours NUMERIC(4,2);

-- 5. Add pricing rules for triciclo_cargo (4 time bands)
-- Cargo pricing: base = 2000/h, per_minute_rate = hourly_rate/60
-- Morning & Afternoon: 2000 CUP/hora
-- Night: 3000 CUP/hora (1.5x)
-- Dawn: 4000 CUP/hora (2.0x)
INSERT INTO pricing_rules (zone_id, service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end, is_active)
VALUES
  (NULL, 'triciclo_cargo', 2000, 0, 33, 2000, '06:00', '12:00', true),
  (NULL, 'triciclo_cargo', 2000, 0, 33, 2000, '12:00', '18:00', true),
  (NULL, 'triciclo_cargo', 3000, 0, 50, 3000, '18:00', '00:00', true),
  (NULL, 'triciclo_cargo', 4000, 0, 67, 4000, '00:00', '06:00', true);
