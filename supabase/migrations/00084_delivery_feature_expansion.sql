-- ============================================================
-- Migration 00084: Delivery Feature Expansion
-- Enables all vehicle types (triciclo, moto, auto) to accept delivery.
-- Adds cargo dimensions, package categories, and reconciles delivery_details.
-- Fixes find_best_drivers RPC with cargo filter.
-- ============================================================

-- ── 1. Expand vehicles table with cargo capacity fields ──
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS max_cargo_length_cm INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS max_cargo_width_cm INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS max_cargo_height_cm INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS accepted_cargo_categories TEXT[] DEFAULT '{}';

-- ── 2. Reconcile delivery_details table ──
-- Migration 00014 created columns (pickup_description, dropoff_description, package_type,
-- estimated_weight, notes) but delivery.service.ts uses different column names.
-- Add the columns the service actually uses:
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS package_description TEXT;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS estimated_weight_kg NUMERIC(6,2);
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS special_instructions TEXT;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS package_category TEXT;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS package_length_cm INTEGER;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS package_width_cm INTEGER;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS package_height_cm INTEGER;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS client_accompanies BOOLEAN DEFAULT false;
ALTER TABLE delivery_details ADD COLUMN IF NOT EXISTS delivery_vehicle_type TEXT;

-- ── 3. RLS: Allow driver to update delivery photo ──
DROP POLICY IF EXISTS "Driver updates delivery photo" ON delivery_details;
CREATE POLICY "Driver updates delivery photo" ON delivery_details
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_id AND rides.driver_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rides
      WHERE rides.id = ride_id AND rides.driver_id = auth.uid()
    )
  );

-- ── 4. Fix find_best_drivers RPC + add cargo filter ──
-- Drop old signature (5 params from 00075)
DROP FUNCTION IF EXISTS find_best_drivers(double precision, double precision, text, integer, integer);

CREATE FUNCTION find_best_drivers(
  p_pickup_lat DOUBLE PRECISION, p_pickup_lng DOUBLE PRECISION,
  p_service_type TEXT, p_radius_m INTEGER DEFAULT 5000, p_limit INTEGER DEFAULT 10,
  p_is_delivery BOOLEAN DEFAULT false
) RETURNS TABLE(
  driver_profile_id UUID, user_id UUID, distance_m DOUBLE PRECISION,
  match_score NUMERIC, rating NUMERIC, acceptance_rate NUMERIC, composite_score DOUBLE PRECISION
) LANGUAGE plpgsql AS $$
DECLARE v_pickup GEOGRAPHY;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;
  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT dp.id AS dp_id, dp.user_id AS dp_user_id, dp.match_score AS dp_match_score,
      dp.rating_avg AS dp_rating, dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
       FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'
       AND r.created_at > NOW() - INTERVAL '30 days' AND r.accepted_at IS NOT NULL)::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    WHERE dp.is_online = true AND dp.status = 'approved' AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      -- FIX: use v.type (not v.service_type which doesn't exist)
      AND v.type = p_service_type
      -- Delivery filter: only drivers that accept cargo
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = dp.user_id
        AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress'))
  )
  SELECT ed.dp_id, ed.dp_user_id, ed.dist_m, ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (0.30 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
     0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
     0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
     0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
     0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
     0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed ORDER BY composite DESC LIMIT p_limit;
END; $$;
