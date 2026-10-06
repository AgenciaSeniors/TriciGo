-- ============================================================
-- 00609: a fleet stays with the company it was created for
--
-- A fleet owner could move a whole fleet (driver_fleets) to another
-- corporate account of theirs, taking every driver the admin reviewed with
-- it. The owner's UPDATE policy, driver_fleets_owner_update, has no WITH
-- CHECK, so its USING is also the check on the new row and any account the
-- owner created passes. `authenticated` can UPDATE every column, and the
-- table's only trigger refreshes updated_at. An owner can create accounts at
-- will (corporate_accounts_insert; 00434 makes each one pending), so they
-- could move a fleet out of the company the admin approved into a new one,
-- swap the fleets of two approved companies through a third (driver_fleets
-- is UNIQUE on corporate_account_id), or do either with an upsert on id.
-- The drivers could also leave without any company changing: they point at
-- the fleet's id, and fleet_members_fleet_id_fkey is ON UPDATE NO ACTION,
-- which accepts a changed key when another row holds it again by the end of
-- the statement. So one UPDATE, or one PostgREST bulk upsert, could give the
-- fleet a new id and let an empty fleet of another company take the old one.
-- 00600 froze fleet_members.fleet_id once the admin reviewed a member,
-- because the approval would travel with it; one level up it still did.
-- What followed: the company the admin approved as a fleet (is_fleet_owner)
-- lost its drivers, so find_best_drivers and accept_ride_v2 stopped keeping
-- its rides for them; the drivers served another company, maybe one the
-- admin approves later in FleetReview, where every member already shows as
-- approved and has no review buttons; and the admin's record of which
-- company has which drivers stopped being true. It never let an unreviewed
-- person in, and RLS already refused a move to someone else's account.
-- Reproduced locally with the live bodies and RLS on. driver_fleets,
-- fleet_members and corporate_accounts had 0 rows in prod on 2026-10-05, so
-- nobody was hit.
--
-- Owner decisions (2026-10-05; the id on 2026-10-06):
--   * The owner can never change a fleet's corporate_account_id or its id,
--     from the moment the fleet exists. No app flow does: submitFleetRequest's
--     upsert finds the fleet by corporate_account_id and sends no id, and a
--     new form session creates a new account and a new fleet. So the rule
--     needs no state.
--   * Silently, like every tg_*_protect_*: the owner's write succeeds and the
--     fleet keeps its company and its id. A move to someone else's account
--     now succeeds the same way instead of failing RLS.
--   * Nothing else. The descriptive fields (name, city, vehicle types,
--     zones, hours, counts, notes) stay editable: only FleetReview shows
--     them, and the only server functions that read driver_fleets
--     (find_best_drivers, accept_ride_v2) use just id and
--     corporate_account_id. corporate_accounts likewise keeps its name,
--     contact and tax id editable after approval, and freezes its id.
--
-- Fix: a new BEFORE UPDATE trigger, tg_driver_fleets_protect(), shaped like
-- the other tg_*_protect_*: admins, callers with no JWT (the service role,
-- migrations) and writers that set app.trusted_fleet_update pass through.
-- None of those writes driver_fleets today; the flag is fleet_members', set
-- only inside GoTrue's transactions and the admin relink RPC. It fires on
-- ON CONFLICT DO UPDATE too. INSERT needs nothing: the owner can only create
-- a fleet for an account of theirs, and that is the company it then keeps.
-- Policies, grants and the foreign key are untouched.
--
-- The migration refuses to replace a function or a trigger of these names
-- that it did not write, and asserts its own result instead of trusting
-- CREATE, since plpgsql only checks a body when it runs: the trigger must be
-- attached as written, and a rolled-back self-test acts as a real non-admin
-- account.
-- Rehearsal: supabase/tests/00609/run.sh.
-- ============================================================

SET lock_timeout = '5s';

-- 1. Only replace what this migration wrote ------------------------------------
DO $$
DECLARE
  v_fn   regprocedure := to_regprocedure('public.tg_driver_fleets_protect()');
  v_md5  text;
  v_tgfn regprocedure;
BEGIN
  IF to_regclass('public.driver_fleets') IS NULL THEN
    RAISE EXCEPTION '00609: public.driver_fleets does not exist (00246 creates it)';
  END IF;
  IF v_fn IS NOT NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
    -- The body below: this migration already ran.
    IF v_md5 IS DISTINCT FROM '8ba548f4638ca9c1f8fcb8899a942890' THEN
      RAISE EXCEPTION '00609: public.tg_driver_fleets_protect() already exists with a body this migration does not know (md5 %). Read it with pg_get_functiondef and keep what it does.', v_md5;
    END IF;
  END IF;
  SELECT t.tgfoid::regprocedure INTO v_tgfn
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.driver_fleets'::regclass AND t.tgname = 'trg_driver_fleets_protect';
  IF v_tgfn IS NOT NULL AND v_tgfn::oid IS DISTINCT FROM v_fn::oid THEN
    RAISE EXCEPTION '00609: a trigger trg_driver_fleets_protect on driver_fleets already runs another function (%)', v_tgfn;
  END IF;
END $$;

-- 2. The owner's UPDATE keeps the fleet's id and company -------------------------
CREATE OR REPLACE FUNCTION public.tg_driver_fleets_protect()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_fleet_update', true) = '1' THEN RETURN NEW; END IF;

  -- 00609: a fleet stays with the company it was created for, and so do the
  -- drivers that point at its id.
  NEW.id := OLD.id;
  NEW.corporate_account_id := OLD.corporate_account_id;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_driver_fleets_protect() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_driver_fleets_protect() TO service_role;

COMMENT ON FUNCTION public.tg_driver_fleets_protect() IS
  'BEFORE UPDATE on driver_fleets. For the fleet owner (a JWT that is not an admin, without app.trusted_fleet_update), an update never changes id or corporate_account_id: a fleet stays with the company it was created for, and so do the drivers that point at its id (00609). The owner''s write succeeds with both kept, and the descriptive fields stay editable. Admins, callers with no JWT and trusted writers pass through.';

CREATE OR REPLACE TRIGGER trg_driver_fleets_protect
  BEFORE UPDATE ON public.driver_fleets
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_fleets_protect();

-- 3. Assert the result -------------------------------------------------------------
-- First, the trigger must be attached as written; without it nothing below
-- holds. Then, acting as a real non-admin account (its id in the JWT claims,
-- the way PostgREST sets them), the block sends a new id, a new company and
-- new details for a fleet of theirs in one update. The write must hit its
-- row, the id and the company must stay, and the details must change.
-- Everything the block does is rolled back, the claims included. A database
-- with no non-admin account has nobody to act as, so the behaviour check is
-- skipped there.
DO $$
DECLARE
  v_owner     uuid;
  v_claim_sub text := current_setting('request.jwt.claim.sub', true);
  v_claims    text := current_setting('request.jwt.claims', true);
  v_corp_a    uuid := gen_random_uuid();
  v_corp_b    uuid := gen_random_uuid();
  v_fleet     uuid := gen_random_uuid();
  v_fleet_new uuid := gen_random_uuid();
  v_rows      integer;
  v_same_id   boolean;
  v_company   text;
  v_details   text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.driver_fleets'::regclass
      AND t.tgname = 'trg_driver_fleets_protect'
      AND t.tgfoid = 'public.tg_driver_fleets_protect()'::regprocedure
      AND t.tgtype = 19                        -- FOR EACH ROW | BEFORE | UPDATE
      AND t.tgenabled = 'O'
      AND cardinality(t.tgattr::int2[]) = 0    -- every column, not UPDATE OF
  ) THEN
    RAISE EXCEPTION '00609: trg_driver_fleets_protect is not attached to driver_fleets as an enabled BEFORE UPDATE FOR EACH ROW trigger';
  END IF;

  SELECT u.id INTO v_owner
  FROM public.users u
  WHERE u.role NOT IN ('admin', 'super_admin')
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE '00609: no non-admin account yet, behaviour self-test skipped';
    RETURN;
  END IF;

  BEGIN
    -- Fixtures, written with no JWT, so the triggers let them through as they are.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('app.trusted_fleet_update', '', true);
    INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
      (v_corp_a, '00609 self-test A', '+5355500609', v_owner),
      (v_corp_b, '00609 self-test B', '+5355500609', v_owner);
    INSERT INTO public.driver_fleets (id, corporate_account_id, name, notes) VALUES
      (v_fleet, v_corp_a, '00609 self-test', 'old notes');

    -- The owner's write, with the owner's id in the JWT claims.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.driver_fleets
       SET id = v_fleet_new, corporate_account_id = v_corp_b, name = '00609 self-test renamed', notes = 'new notes'
     WHERE id = v_fleet;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '00609: the self-test update of the fleet hit % rows', v_rows;
    END IF;
    PERFORM set_config('request.jwt.claims', '', true);

    SELECT id = v_fleet,
           CASE corporate_account_id WHEN v_corp_a THEN 'company a' WHEN v_corp_b THEN 'company b' END,
           concat_ws('|', name, notes)
      INTO v_same_id, v_company, v_details
      FROM public.driver_fleets WHERE id IN (v_fleet, v_fleet_new);

    RAISE EXCEPTION '00609 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00609 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_company IS DISTINCT FROM 'company a' THEN
    RAISE EXCEPTION '00609: the owner moved a fleet to another company: %', coalesce(v_company, 'the fleet is missing');
  END IF;
  IF v_same_id IS NOT TRUE THEN
    RAISE EXCEPTION '00609: the owner changed a fleet''s id';
  END IF;
  IF v_details IS DISTINCT FROM '00609 self-test renamed|new notes' THEN
    RAISE EXCEPTION '00609: the owner could not edit the fleet''s details: % (expected 00609 self-test renamed|new notes)', coalesce(v_details, 'missing');
  END IF;
  IF coalesce(current_setting('request.jwt.claim.sub', true), '') <> coalesce(v_claim_sub, '')
     OR coalesce(current_setting('request.jwt.claims', true), '') <> coalesce(v_claims, '') THEN
    RAISE EXCEPTION '00609: the self-test left a JWT claim set';
  END IF;
  RAISE NOTICE '00609: verified, the owner cannot move a fleet to another company or change its id, and can still edit its details';
END $$;

RESET lock_timeout;
