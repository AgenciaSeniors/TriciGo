-- E4.1: Improved driver matching (DROP old, CREATE new with response time + experience + penalties)
DROP FUNCTION IF EXISTS find_best_drivers(double precision, double precision, text, integer, integer);

CREATE FUNCTION find_best_drivers(
  p_pickup_lat DOUBLE PRECISION, p_pickup_lng DOUBLE PRECISION,
  p_service_type TEXT, p_radius_m INTEGER DEFAULT 5000, p_limit INTEGER DEFAULT 10
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
      AND dp.match_score > 10 AND v.service_type = p_service_type
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

-- E4.2: Driver churn risk view
CREATE OR REPLACE VIEW driver_churn_risk AS
SELECT dp.id AS driver_profile_id, dp.user_id, u.full_name, dp.rating_avg,
  dp.total_rides_completed, dp.acceptance_rate, dp.is_online, dp.status,
  COALESCE(EXTRACT(DAYS FROM (NOW() - (SELECT MAX(r.completed_at) FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'))), 999)::INT AS days_since_last_ride,
  COALESCE((SELECT SUM(r.final_fare_cup) FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed' AND r.completed_at > NOW() - INTERVAL '7 days'), 0)::INT AS earnings_this_week,
  LEAST(100, GREATEST(0,
    LEAST(40, COALESCE(EXTRACT(DAYS FROM (NOW() - (SELECT MAX(r.completed_at) FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'))), 30)::INT * 2) +
    CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END +
    CASE WHEN COALESCE(dp.acceptance_rate, 100) < 50 THEN 20 WHEN COALESCE(dp.acceptance_rate, 100) < 70 THEN 10 ELSE 0 END
  ))::INT AS churn_risk_score,
  CASE
    WHEN LEAST(100, GREATEST(0, LEAST(40, COALESCE(EXTRACT(DAYS FROM (NOW() - (SELECT MAX(r.completed_at) FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'))), 30)::INT * 2) + CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END + CASE WHEN COALESCE(dp.acceptance_rate, 100) < 50 THEN 20 WHEN COALESCE(dp.acceptance_rate, 100) < 70 THEN 10 ELSE 0 END)) >= 50 THEN 'high'
    WHEN LEAST(100, GREATEST(0, LEAST(40, COALESCE(EXTRACT(DAYS FROM (NOW() - (SELECT MAX(r.completed_at) FROM rides r WHERE r.driver_id = dp.id AND r.status = 'completed'))), 30)::INT * 2) + CASE WHEN COALESCE(dp.rating_avg, 5) < 3.5 THEN 20 WHEN COALESCE(dp.rating_avg, 5) < 4.0 THEN 10 ELSE 0 END)) >= 25 THEN 'medium'
    ELSE 'low'
  END AS risk_level
FROM driver_profiles dp LEFT JOIN users u ON u.id = dp.user_id WHERE dp.status = 'approved';
