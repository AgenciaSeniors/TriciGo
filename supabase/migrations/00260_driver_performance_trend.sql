-- ============================================================
-- Migration 00260: get_driver_performance_trend (Phase 2 N3 deep)
--
-- Daily rollup of a driver's completion + cancellation activity over
-- the last N days. Powers the `/profile/performance` dashboard's
-- 30-day trend sparklines.
--
-- Returns one row per day in the window — completed, canceled,
-- offered (counted as accepted_at NOT NULL), and the average
-- response time (seconds between ride creation and acceptance) for
-- that day.
--
-- The frontend can derive:
--   - acceptance_rate per day = completed / offered (NULLIF guard)
--   - cancellation_rate per day = canceled / (completed + canceled)
--   - week-over-week and month-over-month deltas
--   - sparkline data points
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- ============================================================

CREATE OR REPLACE FUNCTION get_driver_performance_trend(
  p_driver_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  day DATE,
  completed_count INTEGER,
  canceled_count INTEGER,
  accepted_count INTEGER,
  avg_response_time_s NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  -- Generate the day series so days with no activity still appear as
  -- zero-rows — sparklines look wrong if missing days collapse.
  WITH day_series AS (
    SELECT generate_series(
      (NOW() - (p_days || ' days')::INTERVAL)::DATE,
      NOW()::DATE,
      INTERVAL '1 day'
    )::DATE AS day
  ),
  ride_rollup AS (
    SELECT
      -- Bucket on the relevant timestamp:
      -- - completed: completed_at
      -- - canceled: canceled_at (or updated_at as fallback)
      -- - accepted: accepted_at
      -- We can't bucket all three on a single column without losing
      -- semantics, so we union three sub-queries.
      day,
      SUM(CASE WHEN bucket = 'completed' THEN 1 ELSE 0 END)::INTEGER AS completed_count,
      SUM(CASE WHEN bucket = 'canceled' THEN 1 ELSE 0 END)::INTEGER AS canceled_count,
      SUM(CASE WHEN bucket = 'accepted' THEN 1 ELSE 0 END)::INTEGER AS accepted_count,
      AVG(CASE WHEN bucket = 'accepted' AND response_seconds IS NOT NULL THEN response_seconds END) AS avg_response_time_s
    FROM (
      SELECT
        completed_at::DATE AS day,
        'completed'::TEXT AS bucket,
        NULL::NUMERIC AS response_seconds
      FROM rides
      WHERE driver_id = p_driver_id
        AND status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at > NOW() - (p_days || ' days')::INTERVAL
      UNION ALL
      SELECT
        COALESCE(canceled_at, updated_at)::DATE AS day,
        'canceled'::TEXT AS bucket,
        NULL::NUMERIC AS response_seconds
      FROM rides
      WHERE driver_id = p_driver_id
        AND status = 'canceled'
        AND COALESCE(canceled_at, updated_at) > NOW() - (p_days || ' days')::INTERVAL
      UNION ALL
      SELECT
        accepted_at::DATE AS day,
        'accepted'::TEXT AS bucket,
        EXTRACT(EPOCH FROM (accepted_at - created_at))::NUMERIC AS response_seconds
      FROM rides
      WHERE driver_id = p_driver_id
        AND accepted_at IS NOT NULL
        AND accepted_at > NOW() - (p_days || ' days')::INTERVAL
    ) sub
    GROUP BY day
  )
  SELECT
    s.day,
    COALESCE(r.completed_count, 0) AS completed_count,
    COALESCE(r.canceled_count, 0) AS canceled_count,
    COALESCE(r.accepted_count, 0) AS accepted_count,
    r.avg_response_time_s
  FROM day_series s
  LEFT JOIN ride_rollup r USING (day)
  ORDER BY s.day ASC;
$$;

COMMENT ON FUNCTION get_driver_performance_trend(UUID, INTEGER) IS
  'Per-driver per-day rollup of completed/canceled/accepted rides + avg '
  'response time. Powers the 30-day trend sparklines on '
  '/profile/performance (Phase 2 N3 deep). Returns zero-rows for days '
  'with no activity so sparklines render contiguously.';
