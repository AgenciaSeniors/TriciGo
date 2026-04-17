-- ============================================================================
-- Migration 00101: Fix trip_insurance_configs
-- ============================================================================
-- Fixes BUG-006: service_type_slug type does not exist (was never created)
-- Fixes BUG-047: trigger references update_updated_at() instead of update_updated_at_column()
-- Creates the table from scratch since migration 00036 failed in production.
-- ============================================================================

-- 1. Create table with TEXT instead of non-existent service_type_slug
CREATE TABLE IF NOT EXISTS trip_insurance_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type TEXT NOT NULL,
  premium_pct NUMERIC(5,4) NOT NULL DEFAULT 0.0500,
  min_premium_cup INTEGER NOT NULL DEFAULT 50,
  max_coverage_cup INTEGER NOT NULL DEFAULT 50000,
  coverage_description_es TEXT NOT NULL DEFAULT '',
  coverage_description_en TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_type)
);

-- 2. RLS
ALTER TABLE trip_insurance_configs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Public read insurance configs"
    ON trip_insurance_configs FOR SELECT
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Service role manages insurance configs"
    ON trip_insurance_configs FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Trigger with CORRECT function name (update_updated_at_column, not update_updated_at)
DROP TRIGGER IF EXISTS trg_trip_insurance_configs_updated ON trip_insurance_configs;
CREATE TRIGGER trg_trip_insurance_configs_updated
  BEFORE UPDATE ON trip_insurance_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 4. Insurance columns on rides (idempotent)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS insurance_selected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS insurance_premium_cup INTEGER NOT NULL DEFAULT 0;

-- 5. Feature flag (idempotent)
INSERT INTO feature_flags (key, value, description)
VALUES ('trip_insurance_enabled', true, 'Habilita seguro de viaje opcional para pasajeros')
ON CONFLICT (key) DO NOTHING;

-- 6. Seed data (idempotent)
INSERT INTO trip_insurance_configs
  (service_type, premium_pct, min_premium_cup, max_coverage_cup, coverage_description_es, coverage_description_en)
VALUES
  ('triciclo_basico', 0.0500, 50, 50000,
   'Cobertura por accidentes y daños durante el viaje',
   'Coverage for accidents and damages during the ride'),
  ('triciclo_premium', 0.0500, 75, 75000,
   'Cobertura premium por accidentes, daños y pérdida de objetos',
   'Premium coverage for accidents, damages and lost items'),
  ('moto_standard', 0.0500, 50, 50000,
   'Cobertura por accidentes y daños durante el viaje',
   'Coverage for accidents and damages during the ride'),
  ('auto_standard', 0.0500, 75, 75000,
   'Cobertura por accidentes, daños y pérdida de objetos',
   'Coverage for accidents, damages and lost items'),
  ('mensajeria', 0.0800, 100, 100000,
   'Cobertura por pérdida o daño del paquete',
   'Coverage for package loss or damage')
ON CONFLICT (service_type) DO NOTHING;
