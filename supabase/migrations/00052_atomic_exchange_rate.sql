-- ============================================================
-- Migration 00052: Atomic Exchange Rate Update
-- Fixes race condition where concurrent reads find no current rate
-- between UPDATE is_current=false and INSERT is_current=true.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_exchange_rate(
  p_source TEXT,
  p_usd_cup_rate NUMERIC,
  p_fetched_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Single transaction: unset old and insert new atomically
  UPDATE exchange_rates SET is_current = false WHERE is_current = true;

  INSERT INTO exchange_rates (source, usd_cup_rate, fetched_at, is_current)
  VALUES (p_source, p_usd_cup_rate, p_fetched_at, true);
END;
$$;
