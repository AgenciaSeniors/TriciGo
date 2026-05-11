-- ============================================================
-- Migration 00263: fix driver_work_sessions trigger RLS regression
--
-- Bug reported on the field: drivers tapping the online/offline
-- toggle saw "no se pudo cambiar el estado" (common.status_change_failed)
-- and the toggle stayed off. Root cause:
--
-- Migration 00261 added a trigger `trg_manage_driver_work_session`
-- on `driver_profiles AFTER UPDATE OF is_online`. The trigger
-- INSERTs into `driver_work_sessions`, which has RLS ENABLED with
-- ONLY a SELECT policy (`driver_work_sessions_owner_select`).
-- Without an INSERT/UPDATE policy and without SECURITY DEFINER on
-- the trigger function, the inner INSERT runs as the authenticated
-- caller and is denied by RLS, raising:
--
--   new row violates row-level security policy for table
--   "driver_work_sessions"
--
-- That error reverts the outer UPDATE on driver_profiles, so the
-- driver's online state never changes.
--
-- Fix: make `manage_driver_work_session()` SECURITY DEFINER and
-- pin its search_path. The function is owned by `postgres` (the
-- migration runner), so SECURITY DEFINER bypasses RLS for the
-- internal INSERT/UPDATE on driver_work_sessions. The OUTER write
-- on driver_profiles still goes through the user's own RLS policy
-- (dp_update_own), preserving the original authorization check.
--
-- We also revoke EXECUTE from PUBLIC and grant only to authenticated
-- so a malicious caller can't invoke the function directly to insert
-- arbitrary work-session rows (the trigger context only fires with
-- NEW.id from a row the user already owns via dp_update_own).
--
-- Idempotent: REPLACE FUNCTION + the trigger is recreated by 00261
-- already (we keep that as-is).
-- ============================================================

CREATE OR REPLACE FUNCTION manage_driver_work_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

-- Lock down direct invocation. The function is intentionally only
-- reachable via the AFTER UPDATE trigger on driver_profiles.
REVOKE ALL ON FUNCTION manage_driver_work_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION manage_driver_work_session() TO authenticated;

COMMENT ON FUNCTION manage_driver_work_session() IS
  'SECURITY DEFINER trigger function for opening/closing driver_work_sessions. '
  'Bypasses RLS on driver_work_sessions because the outer UPDATE on '
  'driver_profiles already enforces ownership via dp_update_own. '
  'Fixes 00261 regression where toggling is_online raised an RLS error '
  'because driver_work_sessions has no INSERT/UPDATE policy.';
