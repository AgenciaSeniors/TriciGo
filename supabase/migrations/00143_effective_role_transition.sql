-- ============================================================
-- Migration 00143: enforce_ride_transition — effective role by profile
--
-- Fixes a latent bug where the trigger enforcing ride status transitions
-- reads users.role as source of truth, but the onboarding flow creates
-- users as role='customer' and later attaches a driver_profiles row
-- WITHOUT promoting users.role='driver'. Result: approved drivers get
-- P0001 "Invalid ride transition from searching to accepted for role customer"
-- when tapping Accept, even though they have a valid approved driver profile
-- and a valid pending ride_offer.
--
-- Two parts:
--   A) One-shot data fix: promote existing users with approved driver
--      profiles to role='driver' (if they were still 'customer').
--   B) Trigger fix: compute effective role dynamically. A user who owns
--      an approved driver_profiles matching NEW.driver_id is treated as
--      'driver' for this transition, regardless of users.role. Admins
--      keep their elevated role. This prevents the same bug for any
--      future users registered under the legacy flow.
-- ============================================================

-- ---- Part A: data fix ----
UPDATE users
SET role = 'driver'
WHERE id IN (
  SELECT user_id FROM driver_profiles WHERE status = 'approved'
)
  AND role = 'customer';

-- ---- Part B: trigger fix ----
CREATE OR REPLACE FUNCTION enforce_ride_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  -- Skip validation for service role (NULL uid) — admin/service path
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  -- Base role from users table
  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Effective role: if the caller owns an approved driver_profiles that
  -- matches NEW.driver_id on this ride, treat them as 'driver' for this
  -- transition. Admins/super_admins keep their elevated role.
  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  -- Check if transition is valid under the effective role
  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  -- Log the transition
  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
