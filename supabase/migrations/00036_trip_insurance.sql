-- ============================================================================
-- Migration 00036: Trip Insurance
-- ============================================================================
-- Adds optional trip insurance that riders can select when confirming a ride.
-- Insurance premium is calculated as a percentage of the estimated fare.
-- Premium goes 100% to platform revenue (not to drivers).
-- ============================================================================

-- 1. Insurance configuration table (per service type)
CREATE TABLE trip_insurance_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type service_type_slug NOT NULL,
  -- Premium as a fraction of the fare (0.05 = 5%)
  premium_pct NUMERIC(5,4) NOT NULL DEFAULT 0.0500,
  -- Minimum premium in CUP (even for very short rides)
  min_premium_cup INTEGER NOT NULL DEFAULT 50,
  -- Maximum coverage amount in CUP
  max_coverage_cup INTEGER NOT NULL DEFAULT 50000,
  coverage_description_es TEXT NOT NULL DEFAULT '',
  coverage_description_en TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(service_type)
);

-- RLS: anyone can read configs, only service_role can write
ALTER TABLE trip_insurance_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read insurance configs"
  ON trip_insurance_configs FOR SELECT
  USING (true);

CREATE POLICY "Service role manages insurance configs"
  ON trip_insurance_configs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Auto-update updated_at
CREATE TRIGGER trg_trip_insurance_configs_updated
  BEFORE UPDATE ON trip_insurance_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 2. Add insurance columns to rides
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS insurance_selected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS insurance_premium_cup INTEGER NOT NULL DEFAULT 0;

-- 3. Feature flag
INSERT INTO feature_flags (key, value, description)
VALUES ('trip_insurance_enabled', true, 'Habilita seguro de viaje opcional para pasajeros')
ON CONFLICT (key) DO NOTHING;

-- 4. Seed insurance configs for all service types
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
