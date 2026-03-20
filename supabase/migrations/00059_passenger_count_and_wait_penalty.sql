-- ============================================================
-- Migration: Passenger count selection + Wait time penalty
-- ============================================================

-- 1. Passenger count on rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_count INTEGER NOT NULL DEFAULT 1;

-- 2. Wait time penalty columns on service_type_configs
ALTER TABLE service_type_configs ADD COLUMN IF NOT EXISTS per_wait_minute_rate_cup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_type_configs ADD COLUMN IF NOT EXISTS free_wait_minutes INTEGER NOT NULL DEFAULT 5;

-- 3. Wait time tracking on rides
ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_time_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_time_charge_cup INTEGER NOT NULL DEFAULT 0;

-- 4. Update max_passengers for triciclos (they vary: 2, 4, 6, 8)
UPDATE service_type_configs SET max_passengers = 8 WHERE slug = 'triciclo_basico';
UPDATE service_type_configs SET max_passengers = 8 WHERE slug = 'triciclo_premium';

-- 5. Set wait time rates per service type
UPDATE service_type_configs SET per_wait_minute_rate_cup = 25, free_wait_minutes = 5 WHERE slug = 'moto_standard';
UPDATE service_type_configs SET per_wait_minute_rate_cup = 30, free_wait_minutes = 5 WHERE slug = 'triciclo_basico';
UPDATE service_type_configs SET per_wait_minute_rate_cup = 30, free_wait_minutes = 5 WHERE slug = 'triciclo_premium';
UPDATE service_type_configs SET per_wait_minute_rate_cup = 0, free_wait_minutes = 0 WHERE slug = 'triciclo_cargo';
UPDATE service_type_configs SET per_wait_minute_rate_cup = 50, free_wait_minutes = 5 WHERE slug = 'auto_standard';
UPDATE service_type_configs SET per_wait_minute_rate_cup = 80, free_wait_minutes = 5 WHERE slug = 'auto_confort';
