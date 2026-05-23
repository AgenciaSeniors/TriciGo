-- ============================================================
-- ADM-001 (security audit 2026-05-23, Admin escalation kill chain):
-- tg_users_protect_admin_fields (BUG-135 / mig 00192) protects
-- role / is_active / level for *non-admin* callers but EXPLICITLY
-- bypasses for any admin via `IF is_admin() THEN RETURN NEW`.
-- `is_admin()` returns true for both 'admin' AND 'super_admin' —
-- there is no tier separation today.
--
-- Combined with `users_update_own` policy (id = auth.uid()), any
-- admin can execute:
--
--   supabase.from('users')
--     .update({ role: 'super_admin' })
--     .eq('id', auth.uid());
--
-- and self-promote. Trigger doesn't block (admin bypass), RLS
-- doesn't block (own row), no other guard.
--
-- Why this matters even though admin/super_admin currently have
-- equivalent capabilities:
--   1. Today, `is_admin()` covers both — no functional difference.
--   2. As soon as we introduce super_admin-only capabilities (this
--      PR introduces the first: write access to platform_config,
--      feature_flags, etc. via ADM-002 / mig 00292), the trivial
--      escalation lets any admin reach those.
--   3. Industry standard: role promotion through a documented RPC
--      with reason + audit log, not via raw column UPDATE.
--
-- Fix:
--   (a) New helper `is_super_admin()` that mirrors is_admin() but
--       checks role = 'super_admin'.
--   (b) Extend trigger with tier separation:
--       - super_admin: bypass all (current admin behavior)
--       - admin: bypass *except* role/level changes (escalation
--         prevention)
--       - non-admin: full lockdown (unchanged)
--   (c) New RPC `promote_user_role(target, new_role, reason)`
--       SECURITY DEFINER, super_admin-only, logs to admin_actions.
--       The legitimate path for any role change.
--
-- Companion: mig 00292 uses is_super_admin() in RLS policies for
-- the security-critical config tables, so the escalation now has
-- real stakes. Mig 00295 (audit_users trigger, planned in PR-05)
-- will close the audit-gap for direct UPDATEs that bypass the RPC.
-- ============================================================

-- ── (a) is_super_admin() helper ──
-- Mirrors is_admin() shape: STABLE, SECURITY DEFINER, search_path-safe.
-- Returns true if the current JWT's user has role='super_admin'.

CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$$;

COMMENT ON FUNCTION public.is_super_admin() IS
  'ADM-001: returns true iff the JWT caller has role=super_admin. Use in RLS / RPC gates for capabilities that must NOT be reachable by self-promotion from a regular admin (commission_rate changes, role promotion, feature_flag toggles for security gates, etc).';

-- ── (b) tier-aware trigger ──
-- super_admin: passthrough (full bypass — unchanged behavior for
--   the historical "is_admin" path).
-- admin (non-super): can change anything EXCEPT role and level
--   (escalation prevention). Other admin tooling (mass updates of
--   is_active for moderation, etc.) keeps working.
-- non-admin: full lockdown — same OLD-pinning as the BUG-135 fix.

CREATE OR REPLACE FUNCTION public.tg_users_protect_admin_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  -- super_admin: full bypass. The only path for promotion that
  -- skips this trigger entirely.
  IF is_super_admin() THEN
    RETURN NEW;
  END IF;

  -- admin (non-super): block role + level escalation specifically;
  -- everything else (is_active, total_rides, etc.) still mutable
  -- via admin tooling.
  IF is_admin() THEN
    NEW.role  := OLD.role;
    NEW.level := OLD.level;
    -- id and created_at are defensive even for admins.
    NEW.id          := OLD.id;
    NEW.created_at  := OLD.created_at;
    RETURN NEW;
  END IF;

  -- Service role / system updates run as 'postgres' or via SECURITY
  -- DEFINER functions; auth.uid() is NULL. Allow them through (same
  -- behavior as BUG-135 trigger pre-this-migration).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Non-admin: full lockdown (unchanged from BUG-135).
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

-- Trigger definition unchanged from BUG-135 (00192); re-declare for completeness.
DROP TRIGGER IF EXISTS trg_users_protect_admin_fields ON public.users;

CREATE TRIGGER trg_users_protect_admin_fields
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_users_protect_admin_fields();

COMMENT ON TRIGGER trg_users_protect_admin_fields ON public.users IS
  'BUG-135 + ADM-001: three-tier protection. super_admin: bypass; admin (non-super): block role/level escalation; non-admin: full field lockdown. Use promote_user_role() RPC for legitimate role changes.';

-- ── (c) promote_user_role RPC ──
-- The one legitimate path to change a user's role. SECURITY DEFINER
-- so it can perform the UPDATE under elevated privilege, gated on
-- is_super_admin() server-side. Logs every promotion to admin_actions
-- with the actor + target + reason + old/new role for audit forensics.

CREATE OR REPLACE FUNCTION public.promote_user_role(
  p_target_user_id uuid,
  p_new_role       user_role,
  p_reason         text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_caller_uid uuid;
  v_old_role   user_role;
BEGIN
  v_caller_uid := auth.uid();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  IF NOT is_super_admin() THEN
    RAISE EXCEPTION 'forbidden: only super_admin can promote user roles';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'reason required (min 10 chars): document why this role change is needed';
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'p_target_user_id required';
  END IF;

  IF p_new_role IS NULL THEN
    RAISE EXCEPTION 'p_new_role required (user_role enum value)';
  END IF;

  SELECT role INTO v_old_role FROM users WHERE id = p_target_user_id;
  IF v_old_role IS NULL THEN
    RAISE EXCEPTION 'target user not found: %', p_target_user_id;
  END IF;

  IF v_old_role = p_new_role THEN
    RETURN jsonb_build_object(
      'success', true,
      'no_change', true,
      'target_user_id', p_target_user_id,
      'role', p_new_role
    );
  END IF;

  -- Perform the actual update. The trigger above sees is_super_admin()
  -- (the SECURITY DEFINER context still carries the original JWT's
  -- auth.uid()), so role change passes.
  UPDATE users SET role = p_new_role WHERE id = p_target_user_id;

  -- Audit trail — admin_actions is INSERT-only for non-admins, but
  -- as SECURITY DEFINER we bypass the RLS deny-by-default for INSERT
  -- as well; the row is immutable post-insert (no UPDATE/DELETE
  -- policies exist).
  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (
    v_caller_uid,
    'promote_user_role',
    'user',
    p_target_user_id::TEXT,
    p_reason || ' [from=' || v_old_role || ' to=' || p_new_role || ']'
  );

  RETURN jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'old_role', v_old_role,
    'new_role', p_new_role,
    'reason', p_reason
  );
END;
$$;

COMMENT ON FUNCTION public.promote_user_role(uuid, user_role, text) IS
  'ADM-001: the legitimate path to change a user role. Requires super_admin caller; reason >= 10 chars; logs to admin_actions. Direct UPDATEs of users.role bypass admin_actions audit and are blocked for non-super-admins by tg_users_protect_admin_fields.';

-- Restrict EXECUTE: only authenticated users can call (the
-- is_super_admin() check inside the body is the actual gate).
-- Without this REVOKE, anon could call and get a clean "forbidden"
-- response but that's still wasted plumbing.
REVOKE EXECUTE ON FUNCTION public.promote_user_role(uuid, user_role, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.promote_user_role(uuid, user_role, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.promote_user_role(uuid, user_role, text) TO authenticated;
