-- ============================================================
-- Migration 00004: Feature Flags table
-- ============================================================

-- Helper trigger function (safe to re-create)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Feature flags table
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value BOOLEAN NOT NULL DEFAULT false,
  description TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ff_select" ON feature_flags FOR SELECT USING (true);
CREATE POLICY "ff_admin" ON feature_flags FOR ALL USING (is_admin());

-- Auto-update updated_at
CREATE TRIGGER set_feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Seed data
INSERT INTO feature_flags (key, value, description) VALUES
  ('surge_pricing_enabled', true, 'Habilitar pricing dinámico por surge'),
  ('cash_payment_enabled', true, 'Permitir pago en efectivo'),
  ('tricicoin_payment_enabled', true, 'Permitir pago con TriciCoin'),
  ('driver_registration_open', true, 'Permitir registro de nuevos conductores'),
  ('promotions_enabled', true, 'Habilitar códigos promocionales'),
  ('sos_enabled', true, 'Habilitar función SOS de emergencia'),
  ('referral_program_enabled', false, 'Habilitar programa de referidos')
ON CONFLICT (key) DO NOTHING;
