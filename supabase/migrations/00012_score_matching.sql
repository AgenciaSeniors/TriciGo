-- ============================================================
-- Migration 00012: Score-Based Driver Matching
-- Adds match_score to driver_profiles, score event log,
-- and a weighted find_best_drivers function.
-- ============================================================

-- Add match_score to driver_profiles
ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS match_score DECIMAL DEFAULT 50.0;

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS acceptance_rate DECIMAL DEFAULT 100.0;

ALTER TABLE driver_profiles
  ADD COLUMN IF NOT EXISTS total_rides_offered INTEGER DEFAULT 0;

-- Score event log
CREATE TABLE IF NOT EXISTS driver_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  delta DECIMAL NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for driver lookup
CREATE INDEX IF NOT EXISTS idx_score_events_driver
  ON driver_score_events(driver_id, created_at DESC);

-- RLS
ALTER TABLE driver_score_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read score events" ON driver_score_events;
CREATE POLICY "Admins read score events" ON driver_score_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
    )
  );

-- ============================================================
-- update_driver_score: Log score event and update match_score
-- ============================================================
CREATE OR REPLACE FUNCTION update_driver_score(
  p_driver_id UUID,
  p_event_type TEXT,
  p_details JSONB DEFAULT NULL
) RETURNS DECIMAL
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_delta DECIMAL;
  v_new_score DECIMAL;
BEGIN
  -- Determine delta based on event type
  CASE p_event_type
    WHEN 'ride_completed' THEN v_delta := 2.0;
    WHEN '5_star_rating' THEN v_delta := 5.0;
    WHEN '4_star_rating' THEN v_delta := 2.0;
    WHEN '3_star_rating' THEN v_delta := 0.0;
    WHEN '2_star_rating' THEN v_delta := -5.0;
    WHEN '1_star_rating' THEN v_delta := -10.0;
    WHEN 'cancel_by_driver' THEN v_delta := -5.0;
    WHEN 'sos_report' THEN v_delta := -20.0;
    WHEN 'tip_received' THEN v_delta := 3.0;
    WHEN 'ride_declined' THEN v_delta := -1.0;
    WHEN 'consecutive_completions_5' THEN v_delta := 5.0;
    WHEN 'admin_adjustment' THEN
      v_delta := COALESCE((p_details->>'delta')::DECIMAL, 0);
    ELSE
      v_delta := 0;
  END CASE;

  IF v_delta = 0 AND p_event_type != 'admin_adjustment' THEN
    RETURN (SELECT match_score FROM driver_profiles WHERE user_id = p_driver_id);
  END IF;

  -- Log the event
  INSERT INTO driver_score_events (driver_id, event_type, delta, details)
  VALUES (p_driver_id, p_event_type, v_delta, p_details);

  -- Update score, clamped between 0 and 100
  UPDATE driver_profiles
  SET match_score = GREATEST(0, LEAST(100, match_score + v_delta))
  WHERE user_id = p_driver_id
  RETURNING match_score INTO v_new_score;

  RETURN COALESCE(v_new_score, 50.0);
END;
$$;

-- ============================================================
-- find_best_drivers: Weighted multi-factor driver matching
-- 0.4*proximity + 0.3*match_score + 0.2*rating + 0.1*acceptance_rate
-- ============================================================
CREATE OR REPLACE FUNCTION find_best_drivers(
  p_pickup_lat DOUBLE PRECISION,
  p_pickup_lng DOUBLE PRECISION,
  p_service_type TEXT,
  p_limit INTEGER DEFAULT 5,
  p_radius_m INTEGER DEFAULT 5000
) RETURNS TABLE (
  driver_id UUID,
  user_id UUID,
  distance_m DOUBLE PRECISION,
  match_score DECIMAL,
  rating_avg DECIMAL,
  acceptance_rate DECIMAL,
  composite_score DOUBLE PRECISION
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_pickup GEOGRAPHY;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id AS dp_id,
      dp.user_id AS dp_user_id,
      dp.match_score AS dp_match_score,
      dp.rating_avg AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    WHERE dp.is_online = true
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND dp.match_score > 10
      AND v.service_type = p_service_type
      AND ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)
      -- No active trip
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.user_id
          AND r.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
      )
  )
  SELECT
    ed.dp_id,
    ed.dp_user_id,
    ed.dist_m,
    ed.dp_match_score,
    ed.dp_rating,
    ed.dp_acceptance,
    -- Weighted composite: lower distance = higher score
    (
      0.4 * (1.0 - LEAST(ed.dist_m / p_radius_m::DOUBLE PRECISION, 1.0)) +
      0.3 * (ed.dp_match_score / 100.0) +
      0.2 * (ed.dp_rating / 5.0) +
      0.1 * (ed.dp_acceptance / 100.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT p_limit;
END;
$$;

-- ============================================================
-- Hook: Update score on ride completion
-- Triggered by complete_ride_and_pay already updating counters.
-- We add a trigger on rides status change to completed.
-- ============================================================
CREATE OR REPLACE FUNCTION trg_ride_completed_score()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM update_driver_score(NEW.driver_id, 'ride_completed',
      jsonb_build_object('ride_id', NEW.id));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ride_completed_score ON rides;
CREATE TRIGGER trg_ride_completed_score
  AFTER UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status != 'completed')
  EXECUTE FUNCTION trg_ride_completed_score();

-- ============================================================
-- Hook: Update score on cancellation by driver
-- ============================================================
CREATE OR REPLACE FUNCTION trg_ride_canceled_score()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'canceled' AND OLD.status != 'canceled'
     AND NEW.driver_id IS NOT NULL
     AND NEW.canceled_by = NEW.driver_id THEN
    PERFORM update_driver_score(NEW.driver_id, 'cancel_by_driver',
      jsonb_build_object('ride_id', NEW.id));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ride_canceled_score ON rides;
CREATE TRIGGER trg_ride_canceled_score
  AFTER UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'canceled' AND OLD.status != 'canceled')
  EXECUTE FUNCTION trg_ride_canceled_score();
