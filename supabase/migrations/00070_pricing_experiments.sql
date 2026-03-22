-- A/B testing for pricing experiments
CREATE TABLE IF NOT EXISTS pricing_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  variant_a_name TEXT NOT NULL DEFAULT 'Control',
  variant_a_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  variant_b_name TEXT NOT NULL DEFAULT 'Test',
  variant_b_multiplier NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  variant_a_rides INT DEFAULT 0,
  variant_a_conversions INT DEFAULT 0,
  variant_b_rides INT DEFAULT 0,
  variant_b_conversions INT DEFAULT 0,
  service_type TEXT,
  city_id UUID REFERENCES cities(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID
);

ALTER TABLE pricing_experiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pe_select" ON pricing_experiments FOR SELECT USING (is_admin());
CREATE POLICY "pe_admin" ON pricing_experiments FOR ALL USING (is_admin());
