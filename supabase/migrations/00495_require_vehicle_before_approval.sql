-- 00495_require_vehicle_before_approval.sql
-- (renumbered from 00491 — that number collided with 00491_campaigns_promo_code_on_delete_set_null.sql)
--
-- Close the onboarding gap that let drivers be APPROVED (and go online)
-- without a registered vehicle.
--
-- Root cause: the driver onboarding persists the vehicle row + terms only at
-- the final "review" Submit (apps/driver/app/onboarding/review.tsx). Documents
-- are persisted earlier, in their own step. An admin could therefore approve a
-- driver from the uploaded documents BEFORE the driver completed that Submit,
-- leaving an "approved" driver with NO row in `vehicles`. Such drivers rendered
-- as a car on the live map (unknown vehicle type → 'auto' fallback) and showed
-- "no verified vehicle" in their profile.
--
-- Fix: extend the security-critical protect trigger
-- `tg_driver_profiles_protect_admin_fields` (DRV-002 lockdown, last body in
-- 00412) with two guards:
--   1. status → 'approved' requires an active vehicle. Placed BEFORE the
--      is_admin()/service-role bypasses so it gates the admin approveDriver
--      UPDATE and the auto-admin edge function alike.
--   2. is_online → true additionally requires an active vehicle (extends the
--      existing DRV-002a approved-only online gate).
--
-- The rest of the function body is reproduced verbatim from the live 00412
-- version (no behavioural change to the field-protection logic).

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00495 (approval gate): an active vehicle is REQUIRED before a driver can be
  -- marked 'approved'. Placed ABOVE the is_admin()/service-role bypasses on
  -- purpose — the admin approveDriver UPDATE and the auto-admin EF must both be
  -- gated. Fires only on the transition TO approved (re-saving an already
  -- approved profile is unaffected).
  IF NEW.status::text = 'approved'
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved'
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle: cannot approve driver % without a registered active vehicle', NEW.id;
  END IF;

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

  -- 00495 (online gate): going online also requires an active vehicle. Approval
  -- already requires one, but a vehicle could be deactivated afterwards — this
  -- keeps a vehicle-less driver from ever appearing online (and as a car).
  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle_for_online: register an active vehicle before going online (driver %)', NEW.id;
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
  -- submit for review. Only while NOT yet approved. Everything else stays
  -- protected, and once approved identity_number/status fall back to admin-only.
  IF auth.uid() = NEW.user_id
     AND OLD.status::text IN ('pending_verification', 'rejected', 'under_review') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status::text IN ('pending_verification', 'rejected')
                AND NEW.status::text = 'under_review') THEN
      NEW.status := OLD.status;
    END IF;
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
