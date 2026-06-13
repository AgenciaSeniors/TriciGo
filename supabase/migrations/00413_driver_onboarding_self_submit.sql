-- 00413_driver_onboarding_self_submit.sql
-- ============================================================================
-- Fix: driver onboarding is broken in runtime — the protect trigger reverts the
-- driver's own status + identity writes. Same class as the tier (00411) and the
-- driver KPIs (00412).
--
-- During onboarding the driver does two direct PostgREST UPDATEs on their own
-- driver_profiles row (auth.uid() = driver, non-admin):
--   * submitForVerification -> UPDATE ... SET status = 'under_review'
--   * updatePersonalInfo     -> UPDATE ... SET identity_number, has_criminal_record,
--                                              criminal_record_details, address, ...
-- RLS `dp_update_own` allows the UPDATE (user_id = auth.uid()), so it reaches the
-- BEFORE-UPDATE trigger `tg_driver_profiles_protect_admin_fields`, which reverts
-- NEW.status / NEW.identity_number / NEW.has_criminal_record /
-- NEW.criminal_record_details for non-admin callers. Result: the UPDATE
-- "succeeds" with no error but nothing changes -> the driver can never submit
-- for review (status stays pending_verification), the admin never sees them in
-- review, the `generate_driver_contract_on_submit` trigger (fires on
-- status -> under_review) never runs, and identity/criminal data is lost.
-- It was never noticed because prod was wiped and the only driver (Carlos) was
-- seeded with status='approved' directly (service-role, bypassing the trigger).
--
-- Fix: add an "owner onboarding" branch — the profile owner
-- (auth.uid() = NEW.user_id), WHILE NOT yet approved
-- (OLD.status IN pending_verification/rejected/under_review), may:
--   * fill their identity fields (identity_number, has_criminal_record,
--     criminal_record_details), and
--   * make ONLY the submit transition {pending_verification, rejected} ->
--     under_review (any other status change is reverted).
-- Everything else (derived KPIs, approved_at, suspended_*, custom rate, quota,
-- id/user_id/created_at) stays reverted even during onboarding. Once approved,
-- this branch no longer applies -> identity_number/status fall back to
-- admin-only (anti-fraud post-approval intact).
--
-- DB-only: submitForVerification / updatePersonalInfo already do the right
-- direct UPDATE; this unblocks them with no client change (no app rebuild).
-- Body reproduced verbatim from the live prod function (post-00412); only the
-- owner-onboarding branch is new.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved' THEN
    RAISE EXCEPTION 'driver_not_approved_for_online: status=% — cannot go online until approved by admin',
      OLD.status;
  END IF;

  IF current_setting('app.trusted_driver_update', true) = '1' THEN
    NEW.status                  := OLD.status;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.identity_number         := OLD.identity_number;
    NEW.has_criminal_record     := OLD.has_criminal_record;
    NEW.criminal_record_details := OLD.criminal_record_details;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  -- Owner during onboarding: allow them to fill their identity fields and
  -- submit for review. Only while NOT yet approved. This is the driver's
  -- legitimate self-service onboarding; everything else stays protected, and
  -- once approved identity_number/status fall back to admin-only (anti-fraud).
  IF auth.uid() = NEW.user_id
     AND OLD.status::text IN ('pending_verification', 'rejected', 'under_review') THEN
    -- status: allow ONLY the submit transition; revert any other status change
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status::text IN ('pending_verification', 'rejected')
                AND NEW.status::text = 'under_review') THEN
      NEW.status := OLD.status;
    END IF;
    -- revert every other protected field (identity_number / has_criminal_record /
    -- criminal_record_details are intentionally NOT reverted here)
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
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

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
  NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;

  RETURN NEW;
END;
$function$;
