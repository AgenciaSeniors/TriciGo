-- 00431_round5_authz_hardening.sql
-- ============================================================================
-- Pre-launch audit round 5 — two confirmed P3 authorization-hardening gaps.
-- Both are currently bounded/latent (no money, no PII breach) but are concrete
-- authorization defects that get worse as the platform grows, so we close them
-- before launch. The third round-5 finding (verify-selfie EF body-supplied
-- driver_id) is fixed in the same PR at the Edge Function layer.
--
-- SECDEF-01: driver_heartbeat(p_driver_id) is SECURITY DEFINER, EXECUTE-granted
-- to authenticated, and its body is an UNGUARDED `UPDATE driver_profiles SET
-- last_heartbeat_at = NOW() WHERE id = p_driver_id`. last_heartbeat_at is a
-- dispatch-eligibility input (find_best_drivers filters on a 3-minute freshness
-- window). The dp_update_own RLS policy restricts heartbeat writes to the owner,
-- but SECURITY DEFINER bypasses RLS, and the driver_profiles protect trigger does
-- NOT cover last_heartbeat_at — so this RPC was the SOLE unguarded write path to
-- an arbitrary driver's heartbeat. Any authenticated user could keep an
-- app-killed-but-still-online approved driver artificially "alive" in the
-- dispatch pool (or refresh a colluding driver's liveness). Fix: gate on
-- ownership/admin, mirroring update_driver_position. Timestamp-only, so impact is
-- an integrity/availability nuisance — but it is a real authz gap.
--
-- DEF-01: referral_codes SELECT policy (referral_codes_select_all) has USING=true
-- for {authenticated}. The table is (user_id, code, created_at), so ANY logged-in
-- user can `SELECT user_id, code FROM referral_codes` and harvest the complete
-- code->user_id mapping for every user = full user-UUID enumeration + every
-- referral/gift code in one query. This bypasses the rate-limited SECURITY DEFINER
-- lookups (find_user_by_gift_code / find_user_by_phone, gated by check_rate_limit
-- 30/3600) that the platform built specifically to prevent enumeration. Latent
-- today (table empty after the pre-launch wipe) but materializes as users
-- register. Fix: scope SELECT to the owner (+ admin). All in-app code resolution
-- already goes through the SECURITY DEFINER RPCs, never a raw table read, so this
-- does not break any legitimate flow.
-- ============================================================================

-- SECDEF-01: gate driver_heartbeat to the owning driver or an admin.
CREATE OR REPLACE FUNCTION public.driver_heartbeat(p_driver_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Only the driver who owns this profile (or an admin) may refresh its heartbeat.
  -- auth.uid() reflects the CALLER even under SECURITY DEFINER (it reads the JWT
  -- claim from the request GUC, not the function owner).
  IF NOT (
    is_admin()
    OR auth.uid() = (SELECT user_id FROM driver_profiles WHERE id = p_driver_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden: cannot refresh another driver''s heartbeat';
  END IF;

  UPDATE driver_profiles
  SET last_heartbeat_at = NOW()
  WHERE id = p_driver_id;
END;
$function$;

-- DEF-01: scope referral_codes SELECT to the owner (+ admin via is_admin()).
-- The existing referral_codes_admin_all (FOR ALL, is_admin()) keeps admin access;
-- the OR is_admin() here is defensive in case that policy is ever removed.
DROP POLICY IF EXISTS referral_codes_select_all ON public.referral_codes;
CREATE POLICY referral_codes_select_own ON public.referral_codes
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR is_admin());
