-- ============================================================
-- 00627 — admins move money only through the audited RPCs
--
-- WHY (admin panel audit, 2026-10-07)
--   Seven money tables had RLS policies that let ANY admin write raw rows
--   through PostgREST: wa_admin (wallet_accounts, ALL), le_insert_admin and
--   lt_insert_admin (ledger, INSERT), pi_admin_all (payment_intents, ALL),
--   wallet_receipts_admin_all (ALL), wrr_admin (wallet_recharge_requests, ALL)
--   and "Admins full access wallet_transfers" (ALL). Verified in prod with a
--   real admin, inside a rolled-back block: +100,000 CUP on the admin's OWN
--   wallet with a plain UPDATE, and a 50,000 ledger credit that also raised the
--   wallet's USD anchor (tg_ledger_maintain_usd_anchor), so the next daily
--   revaluation would have kept it. None of it goes through admin_actions.
--   The RPCs the panel uses for money (admin_adjust_wallet, admin_send_gift,
--   admin_reverse_gift, approve_wallet_recharge, freeze/unfreeze_wallet, ...)
--   bind the caller (auth.uid() = p_admin_id), check the role, audit, and
--   admin_adjust_wallet refuses the admin's own wallet. The raw policies made
--   all of that optional.
--
--   No writer depends on those policies: every function that writes these
--   tables is SECURITY DEFINER (pg_proc, 2026-10-07: none is INVOKER), every
--   Edge Function writes them with the service role, and the panel writes only
--   one of them directly: rejecting a recharge request (pending -> rejected).
--
-- WHAT
--   1. Drop the seven raw-write admin policies.
--   2. Admins keep reading everything. Five tables already have a SELECT policy
--      with is_admin(); wallet_receipts and wallet_transfers had admin reads only
--      through the ALL policies, so they get an admin SELECT policy.
--   3. Rejecting a recharge request stays possible, and only that: an admin may
--      move a PENDING request to REJECTED under their own id.
--   4. Second layer: anon and authenticated lose the table privileges that no
--      policy uses any more (INSERT/UPDATE/DELETE/TRUNCATE where nothing is
--      left; UPDATE/DELETE/TRUNCATE on payment_intents, whose own-insert stays;
--      DELETE/TRUNCATE on wallet_recharge_requests, whose own-insert and admin
--      reject stay). TRUNCATE is not subject to RLS at all. service_role keeps
--      everything: the Edge Functions use it.
--   5. approve_wallet_recharge refuses a request of the approving admin
--      (patched in place from the live body, guarded by its md5).
--
-- ROLLOUT
--   Safe before the panel deploy: the panel already uses the RPCs for every
--   money movement, and its reject UPDATE fits the new policy.
-- ============================================================

SET lock_timeout = '5s';

-- 1. Raw-write admin policies.
DROP POLICY IF EXISTS wa_admin ON public.wallet_accounts;
DROP POLICY IF EXISTS le_insert_admin ON public.ledger_entries;
DROP POLICY IF EXISTS lt_insert_admin ON public.ledger_transactions;
DROP POLICY IF EXISTS pi_admin_all ON public.payment_intents;
DROP POLICY IF EXISTS wallet_receipts_admin_all ON public.wallet_receipts;
DROP POLICY IF EXISTS wrr_admin ON public.wallet_recharge_requests;
DROP POLICY IF EXISTS "Admins full access wallet_transfers" ON public.wallet_transfers;

-- 2. Admin reads that only the ALL policies gave.
DROP POLICY IF EXISTS wallet_receipts_admin_select ON public.wallet_receipts;
CREATE POLICY wallet_receipts_admin_select ON public.wallet_receipts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS wallet_transfers_admin_select ON public.wallet_transfers;
CREATE POLICY wallet_transfers_admin_select ON public.wallet_transfers
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- 3. Rejecting a recharge request (adminService.processRecharge, approved = false).
--    A rejected request is final: approve_wallet_recharge only takes pending ones.
DROP POLICY IF EXISTS wrr_admin_reject ON public.wallet_recharge_requests;
CREATE POLICY wrr_admin_reject ON public.wallet_recharge_requests
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin()) AND status = 'pending')
  WITH CHECK ((SELECT public.is_admin()) AND status = 'rejected' AND processed_by = (SELECT auth.uid()));

-- 4. Table privileges no policy uses any more.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.wallet_accounts, public.ledger_entries, public.ledger_transactions,
  public.wallet_transfers, public.wallet_receipts
  FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.payment_intents FROM anon, authenticated;
REVOKE DELETE, TRUNCATE ON public.wallet_recharge_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE ON public.wallet_recharge_requests FROM anon;

-- 5. No self-approval of a recharge request.
DO $patch$
DECLARE
  v_fn   regprocedure := 'public.approve_wallet_recharge(uuid, uuid)'::regprocedure;
  v_def  text;
  v_md5  text;
  v_old  text := $o$  IF v_req.amount <= 0 THEN RAISE EXCEPTION 'Recharge amount must be positive, got %', v_req.amount; END IF;
$o$;
  v_new  text := $n$  IF v_req.amount <= 0 THEN RAISE EXCEPTION 'Recharge amount must be positive, got %', v_req.amount; END IF;
  -- 00627: an admin cannot approve a recharge into their own wallet.
  IF v_req.user_id = p_admin_id THEN
    RAISE EXCEPTION 'Forbidden: an admin cannot approve their own recharge request'
      USING ERRCODE = '42501';
  END IF;
$n$;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = '754d9bf4837c140f93553b214a6c79cc' THEN
    RETURN;  -- already patched
  END IF;
  IF v_md5 IS DISTINCT FROM 'a3c8a6fd82ebbe2c1e4d15e7852ffba8' THEN
    RAISE EXCEPTION '00627: approve_wallet_recharge is not the body this migration knows (md5 %); re-derive the patch from the live body', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '00627: the patch anchor is not unique in approve_wallet_recharge';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$patch$;

-- Assert the end state.
DO $check$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(c.relname || '.' || pol.polname || ':' || pol.polcmd::text, ', ') INTO v_bad
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
  WHERE c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('wallet_accounts', 'ledger_entries', 'ledger_transactions', 'wallet_transfers',
                      'payment_intents', 'wallet_receipts', 'wallet_recharge_requests')
    AND pol.polcmd <> 'r'
    AND (c.relname::text, pol.polname::text, pol.polcmd::text) NOT IN (('payment_intents', 'pi_own_insert', 'a'),
                                                    ('wallet_recharge_requests', 'wrr_own_insert', 'a'),
                                                    ('wallet_recharge_requests', 'wrr_admin_reject', 'w'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00627: write policies left on money tables: %', v_bad;
  END IF;

  SELECT string_agg(t || ':' || priv || ':' || r, ', ') INTO v_bad
  FROM unnest(ARRAY['wallet_accounts', 'ledger_entries', 'ledger_transactions', 'wallet_transfers', 'wallet_receipts']) t,
       unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv,
       unnest(ARRAY['anon', 'authenticated']) r
  WHERE has_table_privilege(r, 'public.' || t, priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00627: clients can still write money tables: %', v_bad;
  END IF;
  IF has_table_privilege('authenticated', 'public.payment_intents', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.payment_intents', 'DELETE')
     OR has_table_privilege('authenticated', 'public.wallet_recharge_requests', 'DELETE')
     OR has_table_privilege('anon', 'public.wallet_recharge_requests', 'UPDATE') THEN
    RAISE EXCEPTION '00627: payment_intents / wallet_recharge_requests keep client privileges no policy uses';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.wallet_recharge_requests', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.wallet_accounts', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.ledger_entries', 'INSERT') THEN
    RAISE EXCEPTION '00627: a privilege the panel or the Edge Functions need is gone';
  END IF;

  IF (SELECT count(*) FROM pg_policy
      WHERE polname IN ('wallet_receipts_admin_select', 'wallet_transfers_admin_select')
        AND polcmd = 'r'
        AND polrelid IN ('public.wallet_receipts'::regclass, 'public.wallet_transfers'::regclass)) <> 2 THEN
    RAISE EXCEPTION '00627: admins lost read access to receipts or transfers';
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.approve_wallet_recharge(uuid, uuid)'::regprocedure)
     IS DISTINCT FROM '754d9bf4837c140f93553b214a6c79cc' THEN
    RAISE EXCEPTION '00627: approve_wallet_recharge is not the patched body';
  END IF;
END
$check$;

RESET lock_timeout;
