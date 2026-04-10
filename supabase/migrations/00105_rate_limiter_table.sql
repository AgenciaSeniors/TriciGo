-- ============================================================
-- Migration 00105: DB-backed rate limiter
-- BUG-087/088: Replace in-memory rate limiting with PostgreSQL
-- for persistence across function restarts and isolate sharing.
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);

-- RLS: No public access — only via SECURITY DEFINER RPC
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Atomic check-and-increment RPC
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
) RETURNS TABLE(allowed BOOLEAN, current_count INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  -- Compute the start of the current time window
  v_window_start := to_timestamp(
    floor(EXTRACT(EPOCH FROM NOW()) / p_window_seconds) * p_window_seconds
  );

  -- Atomic upsert: insert new entry or increment existing
  INSERT INTO rate_limits (key, window_start, count)
  VALUES (p_key, v_window_start, 1)
  ON CONFLICT (key, window_start)
  DO UPDATE SET count = rate_limits.count + 1
  RETURNING rate_limits.count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_max_requests,
    v_count,
    v_window_start + (p_window_seconds * INTERVAL '1 second');
END;
$$;

-- Cleanup expired entries (call from pg_cron hourly)
CREATE OR REPLACE FUNCTION cleanup_rate_limits()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '2 hours';
$$;
