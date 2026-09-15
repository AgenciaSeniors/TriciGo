-- ============================================================
-- Migration 00591: lock the money/rate-limit RPCs that 00531 meant to
-- lock (it never reached production), and close two helpers of the
-- same class found by the 2026-09-15 payments audit (PR-1).
--
-- Verified against production on 2026-09-15 with
-- has_function_privilege(): 8 of the 9 functions that
-- 00531_lock_down_ungated_public_rpcs.sql revokes were still executable
-- by `anon` or `authenticated`. Only auto_offline_stale_drivers was
-- locked (a later migration recreated it with the right ACL). So this
-- file re-applies 00531 verbatim in spirit — same nine functions, same
-- REVOKE/GRANT — but guarded with to_regprocedure() so a database that
-- lacks one of them (fresh local stack) does not abort halfway.
--
-- What it closes, concretely:
--
--   A. 00531's nine (see that file's header for the per-function
--      analysis). The two with the clearest exploits:
--        refund_rate_limit(key, window)  callable by anon -> anyone
--          resets any rate-limit bucket ('send-sms-otp:phone:<n>',
--          'resolve-recipient:<ip>', 'process-netopia-webhook:<ip>').
--        revalue_anchored_wallets()      callable by anon -> anyone
--          triggers the FX revaluation of every wallet at a moment of
--          their choosing and burns that day's idempotency slot.
--
--   B. check_rate_limit(key, max, window) — executable by any signed-in
--      user. It INCREMENTS an arbitrary bucket, so a user can lock a
--      victim out of OTP verification ('verify-otp:phone:<n>') or make
--      NETOPIA's IPNs hit 429 ('process-netopia-webhook:<netopia-ip>').
--      Its only callers are Edge Functions (service role) and SECURITY
--      DEFINER functions, which keep working: inside a SECDEF function
--      the EXECUTE check runs as the definer (postgres).
--
--   C. ensure_wallet_account(user, type) — executable by authenticated
--      with NO caller check: any user could create a wallet row of ANY
--      type for ANY user, including a look-alike 'platform_fx_reserve'.
--      The apps legitimately call it for the caller's own
--      customer_cash / tricicoin (walletService.ensureAccount), and every
--      internal caller (send_gift, complete_ride_and_pay, admin_send_gift,
--      the referral/corporate triggers, ...) calls it for OTHER users and
--      platform types. corporate_cash is allowed for symmetry with the
--      server-side shape (the corporate wallet is keyed by
--      corporate_accounts.created_by, a real users.id), NOT because a
--      client exercises it: the two corporate call sites
--      (corporate.service.ts:55, wallet.service.ts:381) pass the CORPORATE
--      ACCOUNT id, which wallet_accounts.user_id's FK to users(id) already
--      rejects with 23503 today — a pre-existing bug, swallowed by the
--      caller, tracked separately. The guard therefore distinguishes a DIRECT call
--      (PostgREST RPC: a single PL/pgSQL frame in PG_CONTEXT) from a
--      NESTED one (called from another PL/pgSQL function: 2+ frames),
--      and only restricts the direct case. No app change needed.
--
--   D. Policy wa_insert_own on wallet_accounts (00197) let a user INSERT
--      their own customer_cash row with balance 0 — but said nothing
--      about anchor_usd_cents / unbacked_cup. The daily revaluation sets
--      balance = anchor/100*rate + unbacked, so a user WITHOUT a
--      customer_cash row (261 of 610 active users on 2026-09-15, 110 of
--      them drivers) could seed a huge anchor and be paid the next
--      morning. No client code inserts wallet_accounts directly (every
--      creation goes through ensure_wallet_account), and audit_log shows
--      zero rows ever inserted with a non-zero anchor, so the policy is
--      simply dropped.
--
--   E. revalue_anchored_wallets() looked the reserve up with
--      `WHERE account_type = 'platform_fx_reserve' LIMIT 1` — with C
--      open, a second look-alike row could capture every revaluation
--      leg. Patched IN PLACE (DO $patch$ over pg_get_functiondef, the
--      CLAUDE.md pattern) to pin the lookup to the platform user, so the
--      rest of the live body cannot drift.
--
--   F. send_gift(6-arg) executable by anon. Its body already raises on
--      auth.uid() IS NULL, so this is hygiene: anon out, authenticated
--      and service_role stay.
--
-- Rehearsed locally (Postgres 16, live bodies captured from prod,
-- 55 assertions: 27 red before / 55 green after, applied twice for
-- idempotency). Rollback for any single function is the matching
-- GRANT EXECUTE ... TO authenticated; for D, recreate the policy from
-- 00197 (not recommended).
-- ============================================================

-- ------------------------------------------------------------
-- A + B. REVOKE from anon/authenticated/PUBLIC, GRANT to service_role
-- ------------------------------------------------------------
DO $lock$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    -- 00531 §A: money and pricing entry points reachable by anon
    'public.revalue_anchored_wallets()',
    'public.recompute_cup_from_usd_prices()',
    -- 00531 §B: the rate-limit control plane
    'public.refund_rate_limit(text, integer)',
    -- 00531 §C: readers that hand over other people's data
    'public.get_ride_with_coords(uuid)',
    'public.get_driver_weekly_summary(uuid)',
    'public.check_fraud_signals(uuid)',
    -- 00531 §D: mutating maintenance routines
    'public.auto_offline_stale_drivers()',
    'public.notify_offline_drivers_for_searching_rides()',
    'public.recalc_ride_estimate_with_waypoints(uuid)',
    -- 00591 §B: the other half of the rate-limit control plane
    'public.check_rate_limit(text, integer, integer)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE NOTICE '00591: % is absent in this database, skipping', v_fn;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END $lock$;

-- Assert the outcome instead of trusting the loop. The names above are
-- matched by exact signature, so a production function that drifted to a
-- different argument list would make to_regprocedure() return NULL, raise a
-- NOTICE nobody sees through apply_migration, and leave the hole open — the
-- precise way 00531 reported success while changing nothing. This re-checks
-- every overload that actually exists, by name, and fails the migration.
DO $verify$
DECLARE
  v_fn text;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY (ARRAY[
        'revalue_anchored_wallets', 'recompute_cup_from_usd_prices', 'refund_rate_limit',
        'get_ride_with_coords', 'get_driver_weekly_summary', 'check_fraud_signals',
        'auto_offline_stale_drivers', 'notify_offline_drivers_for_searching_rides',
        'recalc_ride_estimate_with_waypoints', 'check_rate_limit'])
  LOOP
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00591: % is still executable by anon/authenticated — signature drift? (the REVOKE loop matches exact signatures)', v_fn;
    END IF;
  END LOOP;
END $verify$;

-- ------------------------------------------------------------
-- C. ensure_wallet_account: direct-call guard, body otherwise identical
--    to the live one (00469).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_wallet_account(
  p_user_id uuid,
  p_type public.wallet_account_type DEFAULT 'customer_cash'::public.wallet_account_type
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_id  UUID;
  v_uid UUID;
  v_ctx TEXT;
BEGIN
  -- 00591: a DIRECT call (PostgREST RPC from a signed-in, non-admin user)
  -- may only create the caller's own spendable accounts. Internal callers
  -- (send_gift, complete_ride_and_pay, admin_send_gift, the referral and
  -- corporate triggers, ...) are PL/pgSQL functions, so for them PG_CONTEXT
  -- carries at least one more frame below this one; a direct call has
  -- exactly one frame and therefore no newline. Service-role/cron callers
  -- have auth.uid() IS NULL and admins are exempt.
  v_uid := auth.uid();
  IF v_uid IS NOT NULL THEN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF position(E'\n' IN v_ctx) = 0 AND NOT is_admin() THEN
      IF p_user_id IS DISTINCT FROM v_uid
         OR p_type NOT IN ('customer_cash', 'tricicoin', 'corporate_cash') THEN
        RAISE EXCEPTION 'forbidden: ensure_wallet_account may only create your own customer_cash, tricicoin or corporate_cash account'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
  IF v_id IS NULL THEN
    INSERT INTO wallet_accounts (id, user_id, account_type, balance, held_balance, currency, anchor_usd_cents)
    VALUES (gen_random_uuid(), p_user_id, p_type, 0, 0, 'TRC',
            CASE WHEN p_type IN ('customer_cash', 'corporate_cash', 'tricicoin') THEN 0 ELSE NULL END)
    ON CONFLICT (user_id, account_type) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM wallet_accounts WHERE user_id = p_user_id AND account_type = p_type;
    END IF;
  END IF;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) TO authenticated, service_role;

COMMENT ON FUNCTION public.ensure_wallet_account(uuid, public.wallet_account_type) IS
  '00591: idempotent wallet-row creator. Direct RPC calls are restricted to the caller''s own customer_cash/tricicoin/corporate_cash; internal (nested) callers and admins/service role are unrestricted. TRUST BOUNDARY: the exemption is "called from another PL/pgSQL function", not "called by trusted code". Any function executable by authenticated that forwards caller-chosen (p_user_id, p_type) into this helper reopens the hole — validate the type at that call site. Today none does: send_gift whitelists its source type, and the cargo/referral/corporate callers pass fixed types.';

-- ------------------------------------------------------------
-- D. wallet_accounts: no direct INSERT for users (anchor-mint vector)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS wa_insert_own ON public.wallet_accounts;

-- ------------------------------------------------------------
-- E. revalue_anchored_wallets: pin the reserve lookup to the platform user
-- ------------------------------------------------------------
DO $patch$
DECLARE
  v_src    text;
  v_target constant text := $t$WHERE account_type = 'platform_fx_reserve' LIMIT 1$t$;
  v_marker constant text := $m$WHERE account_type = 'platform_fx_reserve' AND user_id = '00000000-0000-0000-0000-000000000001' LIMIT 1$m$;
  v_hits   integer;
BEGIN
  -- Checked on EVERY apply, before the short-circuit below, because pinning
  -- the lookup makes the daily revaluation depend on this row's owner. If the
  -- reserve belonged to anyone else, the pinned SELECT would find nothing and
  -- revalue_anchored_wallets() would hit its `v_fx_account IS NULL -> RAISE
  -- WARNING; RETURN 0` branch: a SILENT no-op, since the FX watchdog (00503)
  -- only watches exchange_rates freshness. An absent reserve (fresh stack) is
  -- fine — the function already handles that and 00443 creates it.
  -- Residual, accepted: wallet_accounts.user_id is FK ... ON DELETE SET NULL,
  -- so deleting the platform user would NULL this owner and silence the
  -- revaluation. Before the pin, the LIMIT 1 lookup would still have found the
  -- row. Deleting user …0001 ('TriciGo Platform', super_admin) breaks far more
  -- than this, but see CLAUDE.md for the monitoring follow-up.
  IF EXISTS (SELECT 1 FROM public.wallet_accounts WHERE account_type = 'platform_fx_reserve')
     AND NOT EXISTS (SELECT 1 FROM public.wallet_accounts
                     WHERE account_type = 'platform_fx_reserve'
                       AND user_id = '00000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION '00591: platform_fx_reserve exists but is not owned by the platform user — pinning the lookup would silently disable the daily revaluation';
  END IF;

  SELECT pg_get_functiondef('public.revalue_anchored_wallets()'::regprocedure) INTO v_src;

  IF position(v_marker IN v_src) > 0 THEN
    RAISE NOTICE '00591: revalue_anchored_wallets already pins the reserve to the platform user; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_target, ''))) / length(v_target);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '00591: expected exactly one reserve lookup in revalue_anchored_wallets, found % — refusing to patch a body that drifted', v_hits;
  END IF;

  EXECUTE replace(v_src, v_target, v_marker);
  RAISE NOTICE '00591: revalue_anchored_wallets reserve lookup pinned to the platform user';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00591: revalue_anchored_wallets is absent in this database; skipping';
END $patch$;

-- ------------------------------------------------------------
-- F. send_gift: anon out, authenticated + service_role stay
-- ------------------------------------------------------------
DO $gift$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    -- Schema-qualified on purpose: with an empty search_path an unqualified enum makes
    -- to_regprocedure() return NULL and the lock would be skipped silently.
    'public.send_gift(uuid, uuid, integer, text, public.wallet_account_type, text)',
    'public.send_gift(uuid, uuid, integer, text, public.wallet_account_type)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE NOTICE '00591: % is absent in this database; skipping', v_fn;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', v_fn);
  END LOOP;

  -- Same drift guard as the $verify$ block above: assert by name, not by the
  -- exact signatures the loop matched.
  FOR v_fn IN
    SELECT p.oid::regprocedure::text FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'send_gift'
  LOOP
    IF has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00591: % is still executable by anon — signature drift?', v_fn;
    END IF;
  END LOOP;
END $gift$;

-- ============================================================
-- Verification (read-only) — expect every anon/auth column false except
-- ensure_wallet_account and send_gift (auth true), and svc true everywhere:
--
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
--          has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc
--   FROM pg_proc p
--   WHERE p.pronamespace = 'public'::regnamespace
--     AND p.proname IN ('revalue_anchored_wallets','recompute_cup_from_usd_prices',
--                       'refund_rate_limit','get_ride_with_coords',
--                       'get_driver_weekly_summary','check_fraud_signals',
--                       'auto_offline_stale_drivers','recalc_ride_estimate_with_waypoints',
--                       'notify_offline_drivers_for_searching_rides','check_rate_limit',
--                       'ensure_wallet_account','send_gift')
--   ORDER BY p.proname;
--
--   SELECT polname FROM pg_policy WHERE polrelid = 'public.wallet_accounts'::regclass;
--   -- expect wa_select, wa_admin only
--
--   SELECT position('platform_fx_reserve'' AND user_id' IN prosrc) > 0
--   FROM pg_proc WHERE proname = 'revalue_anchored_wallets';
--   -- expect true
-- ============================================================
