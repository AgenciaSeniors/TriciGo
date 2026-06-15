-- 00430_freeze_wallet_fix_and_admin_no_self_credit.sql
-- ============================================================================
-- ADMAUTH-01 (audit 2026-06-14): freeze_wallet — the platform's anti-abuse lever
-- ("congelar wallet de abusador"; send_gift fails with 'wallet frozen') — aborts
-- on EVERY call. Its audit INSERT targets admin_actions(... , details) but there
-- is no `details` column, and passes a uuid into the text target_id. So the
-- transaction always rolls back and the wallet is never actually frozen — an
-- admin cannot stop a confirmed abuser. Fix: use the real admin_actions schema
-- (admin_id, action, target_type, target_id::text, reason), mirroring the
-- already-correct unfreeze_wallet. Body otherwise verbatim.
--
-- ADMAUTH-02 (partial): admin_adjust_wallet (direct wallet credit/debit) lets the
-- lower 'admin' tier credit ANY wallet — including their OWN — unlimited spendable
-- balance. Block self-targeting so an admin cannot mint themselves money via this
-- RPC. (Whether ALL money grants should require the higher is_super_admin tier —
-- like pricing/config already do — is a deliberate trust-boundary decision left
-- to the operator; this migration closes the acute self-grant only.)
-- ============================================================================

-- ADMAUTH-01: freeze_wallet audit INSERT uses the real admin_actions columns.
CREATE OR REPLACE FUNCTION public.freeze_wallet(p_user_id uuid, p_reason text, p_admin_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() <> p_admin_id OR NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required (and p_admin_id must match caller)';
  END IF;

  UPDATE wallet_accounts
  SET is_frozen = true, frozen_reason = p_reason,
      frozen_at = NOW(), frozen_by = p_admin_id
  WHERE user_id = p_user_id;

  INSERT INTO admin_actions (admin_id, action, target_type, target_id, reason)
  VALUES (p_admin_id, 'freeze_wallet', 'user', p_user_id::text, p_reason);
  RETURN true;
END;
$function$;

-- ADMAUTH-02: admin_adjust_wallet must not let an admin adjust their OWN wallet.
DO $p$
DECLARE
  v_src text;
  v_target CONSTANT text :=
    'IF NOT COALESCE(v_is_admin, false) THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Forbidden: admin role required'';' || E'\n' ||
    '  END IF;';
  v_repl text;
BEGIN
  v_repl := v_target || E'\n' ||
    '  IF p_target_user_id = p_admin_user_id THEN' || E'\n' ||
    '    RAISE EXCEPTION ''Forbidden: an admin cannot adjust their own wallet'';' || E'\n' ||
    '  END IF;';
  SELECT pg_get_functiondef('public.admin_adjust_wallet(uuid,wallet_account_type,integer,text,uuid)'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE 'admin_adjust_wallet absent; skipping';
  ELSIF position('cannot adjust your own wallet' IN v_src) > 0 OR position('cannot adjust their own wallet' IN v_src) > 0 THEN
    RAISE NOTICE 'admin_adjust_wallet already has self-target guard; skipping';
  ELSIF position(v_target IN v_src) > 0 THEN
    EXECUTE replace(v_src, v_target, v_repl);
    RAISE NOTICE 'admin_adjust_wallet: added self-target block';
  ELSE
    RAISE NOTICE 'admin_adjust_wallet: anchor not found; manual review';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'admin_adjust_wallet absent; skipping';
END $p$;
