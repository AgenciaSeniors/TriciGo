-- ============================================================
-- BUG-134/135 follow-up: the lockdown triggers from 00191
-- (driver_profiles) and 00192 (users) bypassed when is_admin()=true
-- or auth.uid()=NULL. But auth.uid() is still set inside SECURITY
-- DEFINER functions called from an authenticated user — only the
-- role/owner flips to postgres. So legitimate SECDEF callers were
-- getting their writes silently reverted:
--
--   apply_cancellation_penalty   → users.cancellation_count
--   maybe_promote_user_level     → users.level
--   complete_ride_and_pay        → driver_profiles.total_rides_completed
--   update_driver_score          → driver_profiles.match_score
--   update_rating_avg            → driver_profiles.rating_avg
--   tg_ride_offer_increment_offered → driver_profiles.total_rides_offered
--   tg_ride_offer_refresh_acceptance → driver_profiles.acceptance_rate
--   driver_heartbeat / mark_stale_drivers_offline → driver_profiles.is_online
--   admin_grant_grace_trips      → driver_profiles.grace_trips_remaining
--   deduct/recharge_driver_quota → driver_profiles.* fields
--
-- Fix attempt #1: switch from auth.uid() IS NULL to current_user
-- whitelist (postgres / service_role / supabase_admin). This
-- migration installs that intent. Migration 00194 finishes the job
-- by also dropping SECURITY DEFINER from the trigger functions so
-- current_user actually reflects the caller (a SECDEF trigger
-- always sees current_user=postgres regardless of caller, which
-- would make this check no-op).
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  NEW.role               := OLD.role;
  NEW.is_active          := OLD.is_active;
  NEW.level              := OLD.level;
  NEW.total_rides        := OLD.total_rides;
  NEW.total_spent        := OLD.total_spent;
  NEW.cancellation_count := OLD.cancellation_count;
  NEW.last_cancellation_at := OLD.last_cancellation_at;
  NEW.id                 := OLD.id;
  NEW.created_at         := OLD.created_at;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  IF is_admin() THEN
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

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_users_protect_admin_fields() IS
  'BUG-134/135 follow-up: switched bypass detection from auth.uid()=NULL to current_user check. Fixed in 00194 by also removing SECURITY DEFINER so current_user reflects the actual caller.';

COMMENT ON FUNCTION public.tg_driver_profiles_protect_admin_fields() IS
  'BUG-134/135 follow-up: same intent as tg_users_protect_admin_fields. Finished in 00194.';
