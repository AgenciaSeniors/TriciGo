-- ============================================================
-- 00624 — company admins can read their company's balance and employees
--
-- WHY (measured in prod on 2026-10-07, inside rolled-back blocks)
--   1. The company balance shows 0 in the client app, the web and the
--      panel. A company's money is the corporate_cash wallet of the account's
--      creator (corporate_accounts.created_by): register_corporate_account,
--      handle_corporate_ride_completion, process_recharge_payment and
--      admin_adjust_wallet all key it that way. The three screens read
--      wallet_accounts by the company id, where no row exists. Reading by
--      the creator is not enough either: wallet_accounts is own-or-admin
--      (wa_select), so a second admin of the company cannot read the
--      creator's wallet.
--   2. A company admin cannot see who its employees are. corporate_employees
--      lets the admin read the rows, but the screens embed users(full_name,
--      phone), and users is own-or-admin (users_select_own): every other
--      employee came back without a name or phone ("Sin nombre").
--
-- WHAT
--   get_corporate_balance(p_account_id) -> (available, held): the balance of
--     the wallet that funds the company. One row for a known company (0, 0
--     when its creator has no corporate wallet yet), none for an unknown one.
--   get_corporate_employees(p_account_id) -> the company's employee rows,
--     active and former, with each user's full_name and phone, newest first.
--   Both: signed-in users only, and only a platform admin or an active admin
--   of that company (is_corp_admin). Anyone else gets 42501. Neither writes.
--
-- Reading functions only: no table, no data, no lock on a hot table.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.get_corporate_balance(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '3f0a78535f6f62def35d7544abead12c' THEN -- 00624 balance
    RAISE EXCEPTION '00624: unexpected body of get_corporate_balance (md5 %), not replacing it', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.get_corporate_employees(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '707be40934363bf3444de3c66d573e4c' THEN -- 00624 employees
    RAISE EXCEPTION '00624: unexpected body of get_corporate_employees (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.get_corporate_balance(p_account_id uuid)
 RETURNS TABLE(available integer, held integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'get_corporate_balance needs a signed-in user';
  END IF;
  IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador de la empresa puede ver su saldo.',
      DETAIL = 'not_corporate_admin';
  END IF;

  -- The company's money is its creator's corporate_cash wallet.
  RETURN QUERY
    SELECT coalesce(w.balance, 0), coalesce(w.held_balance, 0)
    FROM public.corporate_accounts ca
    LEFT JOIN public.wallet_accounts w
      ON w.user_id = ca.created_by AND w.account_type = 'corporate_cash'
    WHERE ca.id = p_account_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_corporate_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_corporate_balance(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_corporate_employees(p_account_id uuid)
 RETURNS TABLE(id uuid, corporate_account_id uuid, user_id uuid, role text, is_active boolean,
               added_by uuid, created_at timestamptz, full_name text, phone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'get_corporate_employees needs a signed-in user';
  END IF;
  IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador de la empresa puede ver sus empleados.',
      DETAIL = 'not_corporate_admin';
  END IF;

  RETURN QUERY
    SELECT ce.id, ce.corporate_account_id, ce.user_id, ce.role, ce.is_active,
           ce.added_by, ce.created_at, u.full_name, u.phone
    FROM public.corporate_employees ce
    LEFT JOIN public.users u ON u.id = ce.user_id
    WHERE ce.corporate_account_id = p_account_id
    ORDER BY ce.created_at DESC, ce.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_corporate_employees(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_corporate_employees(uuid) TO authenticated, service_role;

-- Assert the end state.
DO $check$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['get_corporate_balance', 'get_corporate_employees'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = format('public.%I(uuid)', v_fn)::regprocedure) THEN
      RAISE EXCEPTION '00624: % is not SECURITY DEFINER', v_fn;
    END IF;
    IF has_function_privilege('anon', format('public.%I(uuid)', v_fn), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', format('public.%I(uuid)', v_fn), 'EXECUTE') THEN
      RAISE EXCEPTION '00624: % must be callable by signed-in users only', v_fn;
    END IF;
  END LOOP;
END
$check$;

RESET lock_timeout;
