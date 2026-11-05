-- ============================================================
-- 00675 — a company admin can remove an employee
--
-- WHY (run in prod on 2026-11-05, inside rolled-back blocks)
--   Every UPDATE and DELETE on corporate_employees failed with 42P17
--   "infinite recursion detected in policy", for a company admin and for a
--   platform admin alike, so the "remove employee" button of the web and of the
--   app has never worked. 00087 fixed this recursion for SELECT, and left the
--   same self-referencing subquery in the UPDATE and DELETE policies. Postgres
--   rewrites that subquery with the table's SELECT policies, one of which has a
--   sublink of its own (on users), and it refuses to enter the same table twice.
--
-- WHAT
--   1. Both policies ask is_corp_admin() instead of reading the table. It is the
--      same question: SECURITY DEFINER, active admin of that company.
--   2. Now that a company admin can really write these rows, one thing has to
--      stay out of reach: the company's money is the creator's corporate_cash
--      wallet (see corporate_accounts.created_by), so a second admin removing
--      the creator would lock them out of their own money. A trigger refuses
--      that, with a message the screens show. Platform admins and anything
--      without a JWT (account deletion, a cascade from the company) go through.
--
-- No table, no data, nothing that blocks the app: corporate_employees has no rows
-- in prod. No screen deletes rows; the policy only keeps working.
-- ============================================================

SET lock_timeout = '5s';

ALTER POLICY corporate_employees_corp_admin_update ON public.corporate_employees
  USING (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()))
  WITH CHECK (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()));

ALTER POLICY corporate_employees_corp_admin_delete ON public.corporate_employees
  USING (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()));

CREATE OR REPLACE FUNCTION public.tg_corporate_employees_protect_creator()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT public.is_admin()
     AND EXISTS (SELECT 1 FROM corporate_accounts
                 WHERE id = OLD.corporate_account_id AND created_by = OLD.user_id)
     AND (TG_OP = 'DELETE'
          OR NOT NEW.is_active
          OR NEW.role <> 'admin'
          OR NEW.user_id <> OLD.user_id
          OR NEW.corporate_account_id <> OLD.corporate_account_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Quien creó la empresa no se puede quitar ni cambiar de rol: los viajes se pagan con su billetera.',
      DETAIL = 'corporate_creator_protected';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- A trigger runs whoever writes the row; EXECUTE only matters to a direct call.
REVOKE ALL ON FUNCTION public.tg_corporate_employees_protect_creator() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_corporate_employees_protect_creator
  BEFORE UPDATE OR DELETE ON public.corporate_employees
  FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_employees_protect_creator();

-- Pasted from Windows (CRLF), the body carries a carriage return: rewrite it without one.
DO $crlf$
DECLARE
  v_def text := pg_get_functiondef('public.tg_corporate_employees_protect_creator()'::regprocedure);
BEGIN
  IF position(chr(13) IN v_def) > 0 THEN
    EXECUTE replace(v_def, chr(13), '');
  END IF;
END
$crlf$;

-- Assert the end state.
DO $check$
DECLARE
  v_fn regprocedure := 'public.tg_corporate_employees_protect_creator()'::regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'corporate_employees'
      AND concat_ws(' ', qual, with_check) ~* 'from[[:space:]]+(public[.])?corporate_employees'
  ) THEN
    RAISE EXCEPTION '00675: a corporate_employees policy still reads corporate_employees';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.corporate_employees'::regclass
      AND tgname = 'trg_corporate_employees_protect_creator'
      AND tgfoid = v_fn AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION '00675: the creator guard is not on corporate_employees';
  END IF;

  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00675: no client may call the creator guard';
  END IF;

  -- The statement that failed, as a signed-in user who manages nothing. It touches
  -- no row, and a recursion in the policies fails it before it gets that far.
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.corporate_employees SET is_active = false WHERE id IS NULL;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$check$;

RESET lock_timeout;
