-- ============================================================
-- BUG-135: users_update_own had no column-level restrictions, so any
-- authenticated user could call:
--
--   supabase.from('users').update({ role: 'super_admin' }).eq('id', auth.uid());
--
-- and instantly become a platform super_admin. That single step
-- bypasses every is_admin() gate added in Tier 4 (process_dispute_refund,
-- admin_reward_referral, approve_redemption, get_platform_earnings,
-- driver_profiles admin field reads via dp_select_own admin clause,
-- driver_documents reads, etc.). It is effectively root access.
--
-- Verified: under SET LOCAL "request.jwt.claims" of a customer's
-- UUID, set role='super_admin' on their own row and the update
-- returned role='super_admin' successfully. Reverted via service
-- role.
--
-- Fix: BEFORE UPDATE trigger that, for non-admin callers, pins
-- security-sensitive fields to OLD values:
--   - role (the big one)
--   - is_active (suspended users could re-activate themselves)
--   - level (loyalty tier elevation)
--   - total_rides / total_spent / cancellation_count (gaming
--     stats that may feed segment / fraud rules)
--   - id (defensive — primary key shouldn't change ever)
--
-- Admin (is_admin()) bypasses the trigger so admin tooling can still
-- promote / demote / suspend users normally. Migration 00194
-- finalises the bypass detection (use current_user instead of
-- auth.uid() IS NULL, and drop SECURITY DEFINER on the trigger so
-- current_user actually reflects the caller).
-- ============================================================

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
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

DROP TRIGGER IF EXISTS trg_users_protect_admin_fields ON public.users;

CREATE TRIGGER trg_users_protect_admin_fields
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_users_protect_admin_fields();

COMMENT ON TRIGGER trg_users_protect_admin_fields ON public.users IS
  'BUG-135: blocks non-admin callers from changing role / is_active / level / ride counters / cancellation counters. Without this, any user could promote themselves to super_admin via a single UPDATE.';
