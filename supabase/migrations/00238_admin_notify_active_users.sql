-- ============================================================
-- Migration 00238: get_active_push_user_ids() RPC
--
-- Returns the set of user_ids that should receive an admin-driven
-- broadcast push notification: those who have a push_token registered
-- AND signed in to the app within the last 30 days. Excludes dormant
-- accounts whose tokens are likely expired anyway.
--
-- Used by the admin web app's "Notificar ahora" button on announcement
-- and blog pages. The admin then forwards the returned user_ids to the
-- existing `send-push` edge function (which already enforces
-- admin/service-role auth, rate limits, and chunking).
--
-- Why not push from this RPC directly: keeping the network call
-- (pg_net → edge function) out of the SQL layer makes admin auditing
-- simpler — every broadcast leaves a trace in admin_action_log via
-- the calling page, and the RPC has no service_role secret embedded.
-- ============================================================

CREATE OR REPLACE FUNCTION get_active_push_user_ids(
  p_active_days integer DEFAULT 30
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  -- Admin-only: this function exposes a population of user_ids and
  -- shouldn't be reachable from a regular rider/driver session.
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  -- Clamp the window so a malicious admin can't request 100-year-old
  -- accounts and trigger millions of push attempts.
  IF p_active_days > 90 OR p_active_days < 1 THEN
    RAISE EXCEPTION 'p_active_days must be between 1 and 90';
  END IF;

  SELECT array_agg(DISTINCT ud.user_id)
  INTO v_user_ids
  FROM user_devices ud
  JOIN auth.users au ON au.id = ud.user_id
  WHERE ud.push_token IS NOT NULL
    AND ud.push_token <> ''
    AND au.last_sign_in_at >= now() - (p_active_days || ' days')::interval;

  RETURN COALESCE(v_user_ids, ARRAY[]::uuid[]);
END;
$$;

REVOKE ALL ON FUNCTION get_active_push_user_ids(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_active_push_user_ids(integer) TO authenticated;
-- Authenticated rather than admin-only at the GRANT layer because the
-- function itself enforces is_admin() and we want clean RAISE
-- exceptions instead of opaque "permission denied" errors for non-admins.

COMMENT ON FUNCTION get_active_push_user_ids(integer) IS
  'Admin-only. Returns user_ids with a registered push_token and a sign-in within the last p_active_days (default 30, max 90). Used by admin "Notificar ahora" buttons.';
