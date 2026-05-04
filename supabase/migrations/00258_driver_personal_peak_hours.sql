-- ============================================================
-- Migration 00258: get_driver_peak_hours_personal
--
-- RPC for the Phase 2 N2 "personal peak hours" feature: returns the
-- driver's earnings + trip count grouped by day-of-week × hour-of-day
-- for the last N days. Lets the UI render a 7×24 heatmap so the driver
-- sees, at a glance, *their personal* best hours to be online (not the
-- platform-wide pattern that `get_peak_hours` returns).
--
-- Notes:
--   - completed_at is the source-of-truth timestamp; we ignore
--     scheduled_at because it represents intent, not earnings.
--   - DOW: 0=Sunday, 6=Saturday (matches Postgres EXTRACT(DOW)).
--   - Hour: 0..23 in driver-local timezone is approximated as
--     server timezone (production runs in America/Havana). If the
--     server timezone changes, switch to AT TIME ZONE 'America/Havana'.
--   - We use total_earnings_cup based on final_fare_cup so cancellations
--     don't show up as earnings — only completed rides count.
--
-- Idempotent: CREATE OR REPLACE FUNCTION.
-- ============================================================

CREATE OR REPLACE FUNCTION get_driver_peak_hours_personal(
  p_driver_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  day_of_week INTEGER,
  hour_of_day INTEGER,
  total_earnings_cup BIGINT,
  trip_count INTEGER
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    EXTRACT(DOW FROM completed_at)::INTEGER AS day_of_week,
    EXTRACT(HOUR FROM completed_at)::INTEGER AS hour_of_day,
    COALESCE(SUM(final_fare_cup), 0)::BIGINT AS total_earnings_cup,
    COUNT(*)::INTEGER AS trip_count
  FROM rides
  WHERE driver_id = p_driver_id
    AND status = 'completed'
    AND completed_at IS NOT NULL
    AND completed_at > NOW() - (p_days || ' days')::INTERVAL
  GROUP BY
    EXTRACT(DOW FROM completed_at),
    EXTRACT(HOUR FROM completed_at)
  ORDER BY total_earnings_cup DESC;
$$;

COMMENT ON FUNCTION get_driver_peak_hours_personal(UUID, INTEGER) IS
  'Per-driver earnings + trip count by DOW x hour for the last N days. '
  'Powers the "Tus mejores horas" heatmap (Phase 2 N2).';
