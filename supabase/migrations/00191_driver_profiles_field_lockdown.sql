-- ============================================================
-- BUG-134: dp_update_own permits drivers to UPDATE their own row
-- without column-level restrictions. Effect: a rejected driver, a
-- suspended driver, or any approved driver can directly call
--
--   supabase.from('driver_profiles').update({
--     status: 'approved',
--     is_financially_eligible: true,
--     match_score: 100,
--     quota_blocked: false,
--     suspended_at: null,
--   }).eq('user_id', auth.uid());
--
-- and bypass admin approval, suspension, financial gates and the
-- match_score system. Verified: a driver in status='rejected' set
-- their row to status='approved', match_score=100,
-- is_financially_eligible=true under their own JWT.
--
-- Impact stack:
--   - rejected applicants can become drivers without KYC.
--   - suspended drivers can re-activate themselves.
--   - drivers can max out match_score and front-load dispatcher
--     ranking.
--   - drivers can clear quota_blocked / negative_balance_since,
--     dodging the wallet-floor gate from BUG-086.
--
-- Fix: BEFORE UPDATE trigger that, for non-admin callers, resets
-- the protected fields to their OLD values. Drivers can still
-- update operational fields (location, heading, is_online,
-- is_on_break, last_heartbeat_at, auto_accept_enabled, custom
-- per-km rate). Admin (is_admin()) bypasses the trigger.
--
-- Why a trigger and not RLS WITH CHECK: RLS WITH CHECK only sees
-- NEW. To express "field X must equal its previous value" we need
-- OLD too, which requires a trigger.
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- Admin bypass — keeps existing admin tooling working.
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  -- Service role / system updates run as 'postgres' or via SECURITY
  -- DEFINER functions; auth.uid() returns NULL in those contexts and
  -- is_admin() above would already have allowed it. Belt-and-suspenders:
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- For everyone else (drivers updating their own row), pin the
  -- admin-controlled and system-controlled fields to OLD values.
  NEW.status                  := OLD.status;
  NEW.is_financially_eligible := OLD.is_financially_eligible;
  NEW.negative_balance_since  := OLD.negative_balance_since;
  NEW.match_score             := OLD.match_score;
  NEW.acceptance_rate         := OLD.acceptance_rate;
  NEW.total_rides             := OLD.total_rides;
  NEW.total_rides_completed   := OLD.total_rides_completed;
  NEW.total_rides_offered     := OLD.total_rides_offered;
  NEW.rating_avg              := OLD.rating_avg;
  NEW.approved_at             := OLD.approved_at;
  NEW.suspended_at            := OLD.suspended_at;
  NEW.suspended_reason        := OLD.suspended_reason;
  NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
  NEW.quota_blocked           := OLD.quota_blocked;
  NEW.identity_number         := OLD.identity_number;
  NEW.has_criminal_record     := OLD.has_criminal_record;
  NEW.criminal_record_details := OLD.criminal_record_details;
  NEW.user_id                 := OLD.user_id;
  NEW.id                      := OLD.id;
  NEW.created_at              := OLD.created_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_profiles_protect_admin_fields ON public.driver_profiles;

CREATE TRIGGER trg_driver_profiles_protect_admin_fields
  BEFORE UPDATE ON public.driver_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_driver_profiles_protect_admin_fields();

COMMENT ON TRIGGER trg_driver_profiles_protect_admin_fields ON public.driver_profiles IS
  'BUG-134: blocks non-admin callers from changing status, KYC, financial-gate, scoring and audit fields on their own driver_profiles row. Drivers can still update operational fields (location, is_online, is_on_break, etc.).';
