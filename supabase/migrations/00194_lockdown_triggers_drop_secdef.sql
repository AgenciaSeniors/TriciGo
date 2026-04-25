-- ============================================================
-- BUG-134/135 follow-up #2: my "current_user" bypass check from
-- migration 00193 was meaningless because the trigger function
-- itself was SECURITY DEFINER. Inside any SECDEF function,
-- current_user is the function's OWNER (postgres) regardless of
-- who called it. So the trigger always saw current_user='postgres'
-- and ALWAYS bypassed — making the lockdown useless.
--
-- Verified by setting role=authenticated + JWT for a customer and
-- attempting role='super_admin'. Without the lockdown working, the
-- admin gates from Tier 4 don't matter.
--
-- Right answer: remove SECURITY DEFINER from the trigger functions.
-- Triggers don't need elevated privs — they only modify NEW. With
-- non-SECDEF triggers, current_user reflects the actual calling
-- context:
--   Direct authenticated UPDATE → current_user='authenticated'
--   SECDEF function calling UPDATE → current_user='postgres'
--                                    (the SECDEF caller promoted)
--   service_role direct call → current_user='service_role'
--
-- The check current_user IN ('postgres', 'service_role',
-- 'supabase_admin') then correctly distinguishes elevated callers
-- from direct user attacks.
--
-- Verified post-fix:
--   customer JWT → role='super_admin' attempt blocked, role pinned to OLD
--   driver JWT  → status='approved' attempt blocked, status pinned to OLD
--   SECDEF function from customer JWT → cancellation_count incremented OK
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
-- NOT SECURITY DEFINER — the trigger only modifies NEW, no elevated reads
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
  'BUG-134/135 follow-up #2: dropped SECURITY DEFINER so current_user reflects the actual caller. SECDEF functions still bypass via current_user=''postgres'' because PostgreSQL changes current_user when entering a SECDEF function.';

COMMENT ON FUNCTION public.tg_driver_profiles_protect_admin_fields() IS
  'BUG-134/135 follow-up #2: same fix as tg_users_protect_admin_fields.';
