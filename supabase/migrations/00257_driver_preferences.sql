-- ============================================================
-- Migration 00257: driver_profiles.preferences (JSONB)
--
-- Equivalente por rol al `users.ride_preferences` JSONB del rider
-- (introducido en una migración anterior). Almacena las preferencias
-- de matching del driver — campos que ayudan al engine de ride_offers
-- a filtrar/scorear ofertas pero que NO son sobre el vehículo (esos
-- viven en `vehicles` ya: accepts_cargo, max_cargo_weight, etc).
--
-- Campos esperados (validados a nivel de aplicación, no DB schema):
--   - max_distance_km: number (default 30) — máxima distancia que el
--     driver acepta recorrer hasta el pickup
--   - accepts_long_trips: boolean (default true) — viajes >10km
--   - music_preference: 'none' | 'low' | 'any' (default 'low')
--   - accepts_minors_alone: boolean (default true) — riders < 18 sin
--     adulto acompañante
--
-- Diferencia vs cargo-settings: cargo-settings vive en la tabla
-- `vehicles` y describe CAPACIDAD del vehículo. driver_profiles.preferences
-- describe PREFERENCIAS personales del driver para el matching.
--
-- Idempotente: si la columna ya existe, ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- es no-op.
-- ============================================================

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN driver_profiles.preferences IS
  'Driver matching preferences (parity with users.ride_preferences). Schema validated app-side. Common keys: max_distance_km, accepts_long_trips, music_preference, accepts_minors_alone.';

-- Default values for backfill — clients leen preferences con `??` así que un
-- objeto vacío también es válido, pero un default rico ahorra checks.
UPDATE driver_profiles
SET preferences = jsonb_build_object(
  'max_distance_km', 30,
  'accepts_long_trips', true,
  'music_preference', 'low',
  'accepts_minors_alone', true
)
WHERE preferences = '{}'::jsonb;
