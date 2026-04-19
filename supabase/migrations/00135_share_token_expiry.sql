-- ============================================================
-- Migration 00135: Share Token Expiration (I1 from ride-flow review)
--
-- Problem: rides.share_token was permanent. Anyone with the link could
-- keep opening the public tracking page forever, even weeks after the
-- ride finished. getPublicRideByShareToken() already filters by
-- share_token_expires_at < NOW(), but the column never existed in
-- production (migration 00097 introduced it but was never applied).
--
-- Fix: add the column, backfill existing completed rides with a 48h
-- window, and install a BEFORE UPDATE trigger that stamps the expiry
-- as soon as the ride transitions into a terminal state.
--
-- Expiry policy: 48 hours after status becomes completed / canceled /
-- disputed. Gives trusted contacts a day-or-two window to review the
-- route history while preventing indefinite access.
-- ============================================================

-- 1. Add the column (idempotent)
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS share_token_expires_at TIMESTAMPTZ;

-- 2. Unique partial index on share_token (avoids full-table scans when
--    looking up rides by token).
CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_share_token
  ON rides(share_token)
  WHERE share_token IS NOT NULL;

-- 3. Backfill already-terminal rides with an expiry 48h past their
--    terminal timestamp. Rides whose terminal timestamp is already
--    >48h in the past become immediately expired (NOW()-ish), which
--    is the desired behavior.
UPDATE rides
SET share_token_expires_at = COALESCE(completed_at, canceled_at) + INTERVAL '48 hours'
WHERE status IN ('completed', 'canceled', 'disputed')
  AND share_token IS NOT NULL
  AND share_token_expires_at IS NULL
  AND COALESCE(completed_at, canceled_at) IS NOT NULL;

-- 4. Trigger: stamp expiry when the ride transitions into a terminal
--    state. Runs BEFORE UPDATE so the new value lands in the same row
--    write, no second UPDATE needed.
CREATE OR REPLACE FUNCTION public.set_share_token_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.status IN ('completed', 'canceled', 'disputed')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('completed', 'canceled', 'disputed'))
     AND NEW.share_token IS NOT NULL
     AND NEW.share_token_expires_at IS NULL
  THEN
    NEW.share_token_expires_at := NOW() + INTERVAL '48 hours';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_share_token_expiry ON rides;
CREATE TRIGGER trg_set_share_token_expiry
  BEFORE UPDATE OF status ON rides
  FOR EACH ROW
  EXECUTE FUNCTION public.set_share_token_expiry();

COMMENT ON COLUMN rides.share_token_expires_at IS
  'Timestamp after which the share_token stops granting access to the public tracking page. Stamped by trg_set_share_token_expiry when the ride reaches a terminal state (completed / canceled / disputed).';
COMMENT ON FUNCTION public.set_share_token_expiry() IS
  'I1 ride-flow review: stamps rides.share_token_expires_at = NOW() + 48h as soon as the ride enters a terminal state.';
