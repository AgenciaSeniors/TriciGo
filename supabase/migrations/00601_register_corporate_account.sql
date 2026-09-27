-- ============================================================
-- Migration 00598: register_corporate_account — create a corporate
-- account, its creator's admin row and the corporate wallet in one
-- transaction.
--
-- Why (verified against production on 2026-09-27):
--   corporateService.registerAccount made three separate client calls and
--   checked the result of the first one only:
--     1. INSERT corporate_accounts                             (checked)
--     2. INSERT corporate_employees (the creator, as admin)    (ignored)
--     3. ensure_wallet_account(<ACCOUNT id>, 'corporate_cash') (ignored)
--
--   Step 3 could never succeed. Every server path keys the corporate_cash
--   wallet by corporate_accounts.created_by, a real users.id:
--   handle_corporate_ride_completion (the only place a corporate ride is
--   charged; complete_ride_and_pay's corporate branch is a NULL),
--   process_recharge_payment, process_recharge_refund and, by the
--   convention 00338 documents, admin_adjust_wallet. The account id is not a
--   users.id, so the call failed on wallet_accounts_user_id_fkey (23503) and,
--   since 00591, on ensure_wallet_account's direct-call guard (42501).
--   Reproduced as a non-admin inside a transaction that rolled back. The
--   client's key came from 00086, whose function no longer exists. Nothing
--   was lost because those same server paths create the wallet on first use.
--
--   Step 2 matters more. The creator's admin row is what the
--   corporate_accounts_corp_admin_update policy, is_corp_admin() and
--   corporateService.getMyAccounts depend on; when it failed, the owner was
--   left with an account they could neither see in their list nor update.
--
--   Checking those errors from the client is not enough on its own: when a
--   later step fails the account row already exists, its creator cannot
--   delete it (corporate_accounts has no DELETE policy), and all three
--   callers (the client app and web corporate request forms, the driver
--   app's fleet request) create another account on retry.
--
-- What: one SECURITY DEFINER function doing the three steps in a single
-- transaction, so either all three rows exist or none does.
--   - created_by is auth.uid(), and p_created_by must match it, which the
--     corporate_accounts_insert policy (WITH CHECK created_by = auth.uid())
--     already required. Nobody registers an account for another user through
--     this function, admins included.
--   - The INSERT still fires tg_corporate_accounts_protect_insert, which sees
--     the caller through auth.uid() and forces a non-admin's account to
--     status 'pending' with every admin-only field reset. The function takes
--     no parameter for any of those fields anyway.
--   - The wallet goes through ensure_wallet_account(auth.uid(),
--     'corporate_cash'), which seeds anchor_usd_cents = 0 (00469). From here
--     it is a nested call, which the 00591 guard exempts; a direct call with
--     the same arguments is allowed as well.
--   - A creator with two corporate accounts still has ONE corporate_cash
--     wallet: the server keys it by user, not by account. Unchanged here.
--
-- Clients: corporateService.registerAccount calls this function and, only
-- when PostgREST reports it missing (PGRST202), runs the same steps itself
-- (wallet, account, admin row), checking every error.
--
-- Rehearsed locally with supabase/tests/00598/run.sh (Postgres 16; the
-- triggers, policies and helpers it touches are live bodies captured from
-- production). Idempotent: CREATE OR REPLACE plus REVOKE/GRANT.
-- Rollback: DROP FUNCTION public.register_corporate_account(uuid, text,
-- text, text, text); the client then runs the steps itself again.
-- ============================================================

CREATE OR REPLACE FUNCTION public.register_corporate_account(
  p_created_by uuid,
  p_name text,
  p_contact_phone text,
  p_contact_email text DEFAULT NULL,
  p_tax_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_account public.corporate_accounts;
BEGIN
  IF v_uid IS NULL OR p_created_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Tu sesión no está disponible. Cierra la app por completo y vuelve a abrirla.',
      DETAIL  = 'session_mismatch';
  END IF;

  INSERT INTO public.corporate_accounts (name, contact_phone, contact_email, tax_id, created_by)
  VALUES (p_name, p_contact_phone, p_contact_email, p_tax_id, v_uid)
  RETURNING * INTO v_account;

  INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, added_by)
  VALUES (v_account.id, v_uid, 'admin', v_uid);

  PERFORM public.ensure_wallet_account(v_uid, 'corporate_cash');

  RETURN to_jsonb(v_account);
END;
$function$;

COMMENT ON FUNCTION public.register_corporate_account(uuid, text, text, text, text) IS
  '00598: creates a corporate account for auth.uid() (p_created_by must match), its creator''s admin row and the creator''s corporate_cash wallet, in one transaction. Returns the account row as jsonb.';

REVOKE ALL ON FUNCTION public.register_corporate_account(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_corporate_account(uuid, text, text, text, text) TO authenticated, service_role;

-- Abort the migration if the privileges did not land: a REVOKE that misses
-- leaves no trace, and a function that creates accounts must never be
-- callable by anon.
DO $check$
DECLARE
  v_fn regprocedure := to_regprocedure('public.register_corporate_account(uuid,text,text,text,text)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '00598: register_corporate_account(uuid,text,text,text,text) does not exist';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION '00598: register_corporate_account must be SECURITY DEFINER';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00598: anon can execute register_corporate_account';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00598: authenticated cannot execute register_corporate_account';
  END IF;
END
$check$;
