-- ============================================================
-- Migration 00261: driver_work_sessions (Phase 2 N6 DB-backed)
--
-- Promotes the AsyncStorage `driver_online_since` MVP (shipped #109)
-- to a DB-backed source of truth. Each row is one continuous
-- online-session, opened when `driver_profiles.is_online` flips
-- false → true and closed when it flips back true → false.
--
-- Why a real table beats the AsyncStorage MVP:
--   - Cross-device: a driver who switches phones doesn't lose their
--     fatigue counter mid-shift.
--   - Aggregable analytics: hours-online per driver-day, used by the
--     D5 shift-adherence comparison and ops dashboards.
--   - Survives reinstalls.
--
-- Backward-compat: the frontend keeps `AsyncStorage.driver_online_since`
-- as a fallback when the DB RPC is missing/slow, so the fatigue banner
-- stays functional even before this migration lands.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, DROP+CREATE for trigger.
-- ============================================================

-- ── Table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_work_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  -- Denormalized total at session close — saves a `SUM(EXTRACT(EPOCH ...))`
  -- on every adherence query.
  total_minutes_online INTEGER,
  -- Future use: total_minutes_in_ride could be derived from rides table
  -- joined on driver_id + completed_at within session window. Left
  -- nullable here so a follow-up migration / worker can backfill.
  total_minutes_in_ride INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_driver_work_sessions_driver
  ON driver_work_sessions(driver_id);
-- Partial index for the hot-path "find open session" query.
CREATE INDEX IF NOT EXISTS idx_driver_work_sessions_open
  ON driver_work_sessions(driver_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_driver_work_sessions_started
  ON driver_work_sessions(started_at DESC);

-- updated_at trigger (function already declared in 00001 / shared)
DROP TRIGGER IF EXISTS set_driver_work_sessions_updated_at ON driver_work_sessions;
CREATE TRIGGER set_driver_work_sessions_updated_at
  BEFORE UPDATE ON driver_work_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Auto-insert / auto-close trigger on driver_profiles.is_online ──

CREATE OR REPLACE FUNCTION manage_driver_work_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- false → true: open a new session
  IF (NEW.is_online IS TRUE AND COALESCE(OLD.is_online, FALSE) IS FALSE) THEN
    -- Defensive: close any orphan open session (e.g. crashed app)
    -- before opening a new one. Without this, the partial index
    -- could end up with multiple "open" rows for the same driver.
    UPDATE driver_work_sessions
    SET
      ended_at = NOW(),
      total_minutes_online = GREATEST(
        EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER / 60,
        0
      )
    WHERE driver_id = NEW.id AND ended_at IS NULL;

    INSERT INTO driver_work_sessions (driver_id, started_at)
    VALUES (NEW.id, NOW());

  -- true → false: close the open session
  ELSIF (NEW.is_online IS FALSE AND OLD.is_online IS TRUE) THEN
    UPDATE driver_work_sessions
    SET
      ended_at = NOW(),
      total_minutes_online = GREATEST(
        EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER / 60,
        0
      )
    WHERE driver_id = NEW.id AND ended_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manage_driver_work_session ON driver_profiles;
CREATE TRIGGER trg_manage_driver_work_session
  AFTER UPDATE OF is_online ON driver_profiles
  FOR EACH ROW
  WHEN (OLD.is_online IS DISTINCT FROM NEW.is_online)
  EXECUTE FUNCTION manage_driver_work_session();

-- ── RLS ──────────────────────────────────────────────────────

ALTER TABLE driver_work_sessions ENABLE ROW LEVEL SECURITY;

-- Driver can read their own sessions only. Writes go through the
-- trigger (security-definer not required because it operates on the
-- table on behalf of the authenticated update on driver_profiles).
DROP POLICY IF EXISTS driver_work_sessions_owner_select ON driver_work_sessions;
CREATE POLICY driver_work_sessions_owner_select ON driver_work_sessions
  FOR SELECT USING (
    driver_id IN (
      SELECT id FROM driver_profiles WHERE user_id = auth.uid()
    )
  );

-- ── RPCs ─────────────────────────────────────────────────────

-- Active (open) session for the calling driver. Returns 0 or 1 rows.
CREATE OR REPLACE FUNCTION get_active_work_session(p_driver_id UUID)
RETURNS TABLE (
  id UUID,
  started_at TIMESTAMPTZ,
  minutes_online INTEGER
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id,
    s.started_at,
    GREATEST(
      EXTRACT(EPOCH FROM (NOW() - s.started_at))::INTEGER / 60,
      0
    ) AS minutes_online
  FROM driver_work_sessions s
  WHERE s.driver_id = p_driver_id
    AND s.ended_at IS NULL
  ORDER BY s.started_at DESC
  LIMIT 1;
$$;

-- Daily adherence for the last N days: planned shift minutes vs actual
-- online minutes. Used by D5 shift-adherence and the N3 performance
-- dashboard if we choose to surface it there. Returns one row per day
-- in the window so sparklines render contiguously.
CREATE OR REPLACE FUNCTION get_driver_work_adherence(
  p_driver_id UUID,
  p_days INTEGER DEFAULT 14
)
RETURNS TABLE (
  day DATE,
  actual_minutes_online INTEGER,
  planned_minutes INTEGER
)
LANGUAGE sql
STABLE
AS $$
  WITH day_series AS (
    SELECT generate_series(
      (NOW() - (p_days || ' days')::INTERVAL)::DATE,
      NOW()::DATE,
      INTERVAL '1 day'
    )::DATE AS day
  ),
  -- Actual: sum of session overlap with each day. A session that
  -- spans midnight gets split across two day rows.
  actual AS (
    SELECT
      d.day,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          LEAST(s.ended_at, (d.day + 1)::TIMESTAMPTZ) -
          GREATEST(s.started_at, d.day::TIMESTAMPTZ)
        ))::INTEGER / 60
      ), 0)::INTEGER AS minutes
    FROM day_series d
    LEFT JOIN driver_work_sessions s
      ON s.driver_id = p_driver_id
      AND s.started_at < (d.day + 1)::TIMESTAMPTZ
      AND COALESCE(s.ended_at, NOW()) > d.day::TIMESTAMPTZ
    GROUP BY d.day
  ),
  -- Planned: for each day, sum of (end - start) for shifts whose
  -- days_of_week includes that day's ISO DOW. Cross-product day_series
  -- × shifts is small (max 14 days × 10 shifts).
  planned AS (
    SELECT
      d.day,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (rs.end_time::TIME - rs.start_time::TIME))::INTEGER / 60
      ), 0)::INTEGER AS minutes
    FROM day_series d
    LEFT JOIN driver_recurring_shifts rs
      ON rs.driver_id = p_driver_id
      AND rs.status = 'active'
      AND EXTRACT(ISODOW FROM d.day)::SMALLINT = ANY(rs.days_of_week)
    GROUP BY d.day
  )
  SELECT
    s.day,
    a.minutes AS actual_minutes_online,
    p.minutes AS planned_minutes
  FROM day_series s
  LEFT JOIN actual a USING (day)
  LEFT JOIN planned p USING (day)
  ORDER BY s.day ASC;
$$;

-- ── COMMENTs ─────────────────────────────────────────────────

COMMENT ON TABLE driver_work_sessions IS
  'Continuous online-session log per driver. Opened by trigger when '
  'driver_profiles.is_online flips false→true; closed when it flips '
  'back. Source of truth for the anti-fatigue banner (replaces the '
  'AsyncStorage MVP from N6 v1) and for D5 shift-adherence calculations.';

COMMENT ON FUNCTION get_active_work_session(UUID) IS
  'Returns the driver''s currently-open work session (ended_at IS NULL) '
  'or zero rows. Used by the home bottom sheet to drive the fatigue '
  'banner with the cross-device session timestamp.';

COMMENT ON FUNCTION get_driver_work_adherence(UUID, INTEGER) IS
  'Daily comparison of actual minutes online vs planned minutes from '
  'driver_recurring_shifts (D5). One row per day in the window. '
  'Sessions spanning midnight are split correctly.';
