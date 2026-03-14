-- ============================================================
-- Migration 00045: Analytics RPCs for Admin Dashboard
-- ============================================================

-- 1. Rides by day (trend)
CREATE OR REPLACE FUNCTION get_rides_by_day(p_days_back INT DEFAULT 30)
RETURNS TABLE (
  day DATE,
  total BIGINT,
  completed BIGINT,
  canceled BIGINT,
  revenue NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    d.day::DATE,
    COUNT(r.id) AS total,
    COUNT(r.id) FILTER (WHERE r.status = 'completed') AS completed,
    COUNT(r.id) FILTER (WHERE r.status = 'canceled') AS canceled,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM generate_series(
    CURRENT_DATE - (p_days_back - 1),
    CURRENT_DATE,
    '1 day'::INTERVAL
  ) AS d(day)
  LEFT JOIN rides r ON r.created_at::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
$$;

-- 2. Rides by service type
CREATE OR REPLACE FUNCTION get_rides_by_service_type(p_days_back INT DEFAULT 30)
RETURNS TABLE (
  service_type TEXT,
  count BIGINT,
  revenue NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    r.service_type::TEXT,
    COUNT(*) AS count,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM rides r
  WHERE r.created_at >= CURRENT_DATE - p_days_back
  GROUP BY r.service_type
  ORDER BY count DESC;
$$;

-- 3. Rides by payment method
CREATE OR REPLACE FUNCTION get_rides_by_payment_method(p_days_back INT DEFAULT 30)
RETURNS TABLE (
  payment_method TEXT,
  count BIGINT,
  revenue NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    r.payment_method::TEXT,
    COUNT(*) AS count,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM rides r
  WHERE r.created_at >= CURRENT_DATE - p_days_back
  GROUP BY r.payment_method
  ORDER BY count DESC;
$$;

-- 4. Peak hours
CREATE OR REPLACE FUNCTION get_peak_hours(p_days_back INT DEFAULT 30)
RETURNS TABLE (
  hour INT,
  avg_rides NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH hourly AS (
    SELECT
      EXTRACT(HOUR FROM r.created_at)::INT AS hour,
      r.created_at::DATE AS day,
      COUNT(*) AS rides
    FROM rides r
    WHERE r.created_at >= CURRENT_DATE - p_days_back
    GROUP BY EXTRACT(HOUR FROM r.created_at)::INT, r.created_at::DATE
  )
  SELECT
    h.hour,
    ROUND(AVG(h.rides), 1) AS avg_rides
  FROM hourly h
  GROUP BY h.hour
  ORDER BY h.hour;
$$;

-- 5. Top drivers
CREATE OR REPLACE FUNCTION get_top_drivers(p_limit INT DEFAULT 10)
RETURNS TABLE (
  driver_id UUID,
  driver_name TEXT,
  rides_count BIGINT,
  rating NUMERIC,
  revenue NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    dp.id AS driver_id,
    u.full_name AS driver_name,
    dp.total_rides AS rides_count,
    dp.rating_avg AS rating,
    COALESCE(SUM(r.final_fare_cup) FILTER (WHERE r.status = 'completed'), 0) AS revenue
  FROM driver_profiles dp
  JOIN users u ON u.id = dp.id
  LEFT JOIN rides r ON r.driver_id = dp.id
    AND r.created_at >= CURRENT_DATE - 30
  WHERE dp.status = 'approved'
  GROUP BY dp.id, u.full_name, dp.total_rides, dp.rating_avg
  ORDER BY rides_count DESC
  LIMIT p_limit;
$$;

-- 6. Driver utilization (current snapshot)
CREATE OR REPLACE FUNCTION get_driver_utilization()
RETURNS TABLE (
  online INT,
  busy INT,
  idle INT,
  offline INT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COUNT(*) FILTER (WHERE dp.is_online = true)::INT AS online,
    COUNT(*) FILTER (WHERE dp.is_online = true AND EXISTS(
      SELECT 1 FROM rides r
      WHERE r.driver_id = dp.id
      AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS busy,
    COUNT(*) FILTER (WHERE dp.is_online = true AND NOT EXISTS(
      SELECT 1 FROM rides r
      WHERE r.driver_id = dp.id
      AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS idle,
    COUNT(*) FILTER (WHERE dp.is_online = false OR dp.is_online IS NULL)::INT AS offline
  FROM driver_profiles dp
  WHERE dp.status = 'approved';
$$;
