-- Surge predictions based on historical ride patterns
CREATE TABLE IF NOT EXISTS surge_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID REFERENCES zones(id),
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour_of_day INT NOT NULL CHECK (hour_of_day BETWEEN 0 AND 23),
  predicted_multiplier NUMERIC(3,1) NOT NULL DEFAULT 1.0,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.5,
  avg_rides_in_window INT NOT NULL DEFAULT 0,
  avg_rides_baseline INT NOT NULL DEFAULT 0,
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(zone_id, day_of_week, hour_of_day)
);

ALTER TABLE surge_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sp_select" ON surge_predictions FOR SELECT USING (true);
CREATE POLICY "sp_admin" ON surge_predictions FOR ALL USING (is_admin());
CREATE INDEX idx_surge_predictions_lookup ON surge_predictions(day_of_week, hour_of_day);
