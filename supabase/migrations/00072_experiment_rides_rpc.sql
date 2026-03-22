CREATE OR REPLACE FUNCTION increment_experiment_rides(p_experiment_id UUID, p_variant TEXT)
RETURNS void AS $$
BEGIN
  IF p_variant = 'a' THEN
    UPDATE pricing_experiments SET rides_variant_a = rides_variant_a + 1 WHERE id = p_experiment_id;
  ELSIF p_variant = 'b' THEN
    UPDATE pricing_experiments SET rides_variant_b = rides_variant_b + 1 WHERE id = p_experiment_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
