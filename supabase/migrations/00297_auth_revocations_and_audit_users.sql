-- ============================================================
-- CC-01 + ADM-012 (security audit 2026-05-23, Auth hardening):
--
-- ─── CC-01: logout does not revoke JWTs server-side ──────────
--
-- `authService.signOut()` (packages/api/src/services/auth.service.ts:173-176)
-- only calls `supabase.auth.signOut()` which clears the local
-- session storage (AsyncStorage/SecureStore on mobile,
-- localStorage on web). The JWT itself remains valid server-side
-- until its natural `expires_at` (default 1 hour in Supabase).
--
-- Exploitation window: user logs out on device A → attacker who
-- captured the JWT from device A in the prior hour (swap RAM,
-- compromised device) can replay the token on device B and act
-- as the user for up to ~50 minutes post-logout.
--
-- Fix (this migration provides the infrastructure):
--   1. `auth_revocations(user_id pk, revoked_at)` — append-only
--      log of revoke events.
--   2. `revoke_user_tokens(p_user_id)` RPC — caller must be
--      the same user or an admin; UPSERTs the user's revocation
--      timestamp.
--   3. `is_session_revoked()` helper — reads the JWT's `iat`
--      (issued-at) claim and checks against revocations; returns
--      true if a revocation entry exists with revoked_at > iat.
--   4. Daily cron `cleanup_auth_revocations()` — deletes rows
--      older than 24h (JWT max lifetime — older revocations no
--      longer protect against any valid JWT).
--
-- The signOut wiring in TS is in this same PR. The helper
-- `is_session_revoked()` is exposed for future RLS policies to
-- consume (write policies on rides, wallet_accounts, etc.) —
-- *intentionally not added to every policy in this PR* to keep
-- the change reviewable. Each addition is a separate decision per
-- table. The helper is here so subsequent PRs can adopt it
-- without re-defining the contract.
--
-- Follow-up work in subsequent PR(s):
--   * Add `is_session_revoked() = false` to RLS WITH CHECK on
--     critical write policies (rides UPDATE, wallet_accounts
--     UPDATE/INSERT, payment_intents INSERT, etc.)
--   * Consider reducing default JWT_EXPIRY from 1h to 15min in
--     Supabase Auth config (UX hit but collapses the worst-case
--     window).
--
-- ─── ADM-012: audit_users trigger missing ────────────────────
--
-- `audit_rides` and `audit_driver_profiles` triggers (mig 00001
-- and 00191 respectively) call record_audit() AFTER INSERT/UPDATE/
-- DELETE to capture changes for forensics. But `users` has no
-- such trigger — direct UPDATEs to users.role / is_active / etc.
-- (especially via ADM-001 attempted escalation paths) leave no
-- audit trail in the `audit_log` table.
--
-- Fix: AFTER INSERT/UPDATE/DELETE trigger on `users` calling
-- `record_audit()`. Mirrors the existing pattern from rides /
-- driver_profiles. No changes to record_audit() itself.
--
-- This closes the audit gap that combined with ADM-001's trigger
-- bypass (`IF is_admin() THEN RETURN NEW`) lets an admin's role
-- change go unrecorded. With this trigger plus the ADM-001 fix
-- (mig 00291), any role mutation leaves both the immutable
-- audit_log entry AND the structured admin_actions log entry
-- (the latter via promote_user_role RPC).
-- ============================================================

-- ── auth_revocations table ──

CREATE TABLE IF NOT EXISTS public.auth_revocations (
  user_id    uuid PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason     text
);

COMMENT ON TABLE public.auth_revocations IS
  'CC-01: append-only revocation log. Populated by revoke_user_tokens() RPC. Consumed by is_session_revoked() helper. Cleaned daily by cleanup_auth_revocations() for entries older than 24h (max JWT lifetime).';

-- RLS: only service_role + the user themselves can read their
-- revocation entry. Writes only via RPC.

ALTER TABLE public.auth_revocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_revocations_self_read ON public.auth_revocations
  FOR SELECT USING (user_id = (SELECT auth.uid()) OR is_admin());

-- ── revoke_user_tokens RPC ──

CREATE OR REPLACE FUNCTION public.revoke_user_tokens(
  p_user_id uuid DEFAULT NULL,
  p_reason  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_caller_uid uuid;
  v_target     uuid;
BEGIN
  v_caller_uid := auth.uid();

  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  -- Default to caller's own user when no target specified
  -- (the signOut common-case).
  v_target := COALESCE(p_user_id, v_caller_uid);

  -- Authorization: caller is the target, or caller is admin.
  IF v_target <> v_caller_uid AND NOT is_admin() THEN
    RAISE EXCEPTION 'forbidden: can only revoke own tokens (or admin can revoke any)';
  END IF;

  INSERT INTO auth_revocations (user_id, revoked_at, reason)
  VALUES (v_target, now(), p_reason)
  ON CONFLICT (user_id) DO UPDATE
    SET revoked_at = EXCLUDED.revoked_at,
        reason     = COALESCE(EXCLUDED.reason, auth_revocations.reason);

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_target,
    'revoked_at', now()
  );
END;
$$;

COMMENT ON FUNCTION public.revoke_user_tokens(uuid, text) IS
  'CC-01: revokes JWTs issued before the call. Caller can revoke own; admin can revoke any. UPSERT on user_id — repeated calls just bump revoked_at forward. Consumed by is_session_revoked() helper.';

REVOKE EXECUTE ON FUNCTION public.revoke_user_tokens(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_user_tokens(uuid, text) TO authenticated;

-- ── is_session_revoked helper ──

CREATE OR REPLACE FUNCTION public.is_session_revoked() RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid;
  v_iat bigint;
  v_revoked_at timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- Service role / anon / system contexts — not subject to revocation.
    RETURN false;
  END IF;

  -- Extract `iat` (issued-at unix timestamp) from the JWT.
  BEGIN
    v_iat := (auth.jwt() ->> 'iat')::bigint;
  EXCEPTION WHEN OTHERS THEN
    -- Missing or malformed claim — treat as not revoked (fail open
    -- so we don't lock out legitimate sessions if the JWT shape
    -- changes in a future Supabase update). Callers requiring
    -- strict enforcement should add an explicit `auth.jwt() ?
    -- 'iat'` check.
    RETURN false;
  END;

  SELECT revoked_at INTO v_revoked_at
  FROM auth_revocations
  WHERE user_id = v_uid;

  -- No entry → not revoked.
  IF v_revoked_at IS NULL THEN
    RETURN false;
  END IF;

  -- Revoked iff the revocation timestamp is AFTER the JWT was issued.
  RETURN v_revoked_at > to_timestamp(v_iat);
END;
$$;

COMMENT ON FUNCTION public.is_session_revoked() IS
  'CC-01: helper for RLS policies. Returns true iff the caller has a revocation entry with revoked_at AFTER the current JWT''s iat. Service role / anon contexts always return false. To enforce: add `AND NOT is_session_revoked()` to WITH CHECK on critical write policies. Not auto-applied — each policy adds it deliberately.';

-- ── Daily cleanup of stale revocation entries ──
-- JWT default lifetime is 1h. Revocations older than 24h cannot
-- possibly invalidate any currently-valid JWT (24h cushion vs the
-- 1h max lifetime + clock skew tolerance). Cleanup keeps the
-- table small.

CREATE OR REPLACE FUNCTION public.cleanup_auth_revocations() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM auth_revocations
  WHERE revoked_at < now() - interval '24 hours'
  RETURNING 1 INTO v_deleted;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.cleanup_auth_revocations() IS
  'CC-01: deletes auth_revocations entries older than 24h. Should be scheduled via pg_cron daily. Idempotent / safe to call ad-hoc.';

REVOKE EXECUTE ON FUNCTION public.cleanup_auth_revocations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_auth_revocations() TO service_role;

-- Schedule via pg_cron if extension is installed. If not,
-- attempting to schedule should fail silently — the cleanup can
-- be invoked manually or via an external cron job in that case.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup_auth_revocations',
      '0 3 * * *',  -- daily at 03:00 UTC
      $cron$SELECT public.cleanup_auth_revocations();$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron not available or already scheduled — non-fatal.
  RAISE NOTICE 'cleanup_auth_revocations not scheduled (pg_cron unavailable or already exists): %', SQLERRM;
END $$;

-- ============================================================
-- ADM-012: audit_users trigger
-- ============================================================

DROP TRIGGER IF EXISTS audit_users ON public.users;

CREATE TRIGGER audit_users
  AFTER INSERT OR UPDATE OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.record_audit();

COMMENT ON TRIGGER audit_users ON public.users IS
  'ADM-012: forensic audit trigger mirroring audit_rides (mig 00001) and audit_driver_profiles (mig 00191). Closes the audit gap that combined with ADM-001 (admin trigger bypass) let role changes go unrecorded in audit_log. Now every users mutation leaves an audit_log entry regardless of who made it.';
