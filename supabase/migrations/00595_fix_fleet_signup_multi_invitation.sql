-- ============================================================
-- 00595: the fleet signup trigger aborted the signup of anyone with two or
-- more pending invitations
--
-- auto_link_fleet_member_on_signup() runs AFTER INSERT ON public.users and
-- links the new account to the fleet invitations that carry its phone number.
-- Its UPDATE ends with `RETURNING id INTO v_member_id`. In PL/pgSQL an
-- INSERT/UPDATE/DELETE ... RETURNING ... INTO raises TOO_MANY_ROWS when the
-- statement touches more than one row, STRICT or not (the bug 00594 fixed in
-- cleanup_auth_revocations). fleet_members is only unique on
-- (fleet_id, driver_phone) with the phone as typed, while the trigger matches
-- on the normalized phone, so one person can hold two matching invitations:
-- one from each of two fleets (possible since 00246), or two in one fleet
-- that stored the number in two formats, "+5355551234" and "55551234"
-- (possible since 00461 switched the match to _normalize_cuban_phone). Then
-- the trigger raised, the INSERT into public.users rolled back, and that
-- person could not create an account at all. Nobody was hit: fleet_members,
-- driver_fleets and corporate_accounts all had 0 rows on 2026-09-25.
--
-- Fix: drop the RETURNING ... INTO and the variable it filled, which nothing
-- read. The UPDATE then links every matching invitation. That is what the
-- admin path already does: relink_fleet_member_for_existing_driver() runs the
-- same UPDATE with the same WHERE and returns GET DIAGNOSTICS ROW_COUNT.
-- Nothing in the schema limits a driver to one fleet (no unique index on
-- fleet_members.driver_id; accept_ride_v2 and find_best_drivers only test
-- EXISTS). Everything else is the live definition read with
-- pg_get_functiondef on 2026-09-25 (md5(prosrc)
-- 0b74fd48e33257ba39bd719376d1a732, identical to 00461): same guard,
-- SECURITY DEFINER, search_path and trusted-update flag. CREATE OR REPLACE
-- keeps the live ACL (postgres and service_role only) and the trigger on
-- public.users; the REVOKE/GRANT restate the ACL for a fresh database.
-- Rehearsal: supabase/tests/00595/run.sh.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;

-- Assert the fix instead of trusting the CREATE: a plpgsql body is not checked
-- until it runs, and the bug only shows with two matching invitations. Build
-- one fleet holding the same number in two formats, fire the real trigger
-- function from a scratch table (so no account is created), count the links,
-- then undo everything the block did. If the trigger still raises
-- TOO_MANY_ROWS, that error is not the one caught here, so it aborts the
-- migration. The fixtures need an existing user for their foreign keys; a
-- database without users has nobody to protect yet, so the check is skipped.
DO $$
DECLARE
  v_user   uuid;
  v_corp   uuid := gen_random_uuid();
  v_fleet  uuid := gen_random_uuid();
  v_linked integer;
BEGIN
  SELECT id INTO v_user FROM public.users ORDER BY created_at, id LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE '00595: no users yet, self-test skipped';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by)
    VALUES (v_corp, '00595 self-test', '+5350000595', v_user);
    INSERT INTO public.driver_fleets (id, corporate_account_id, name)
    VALUES (v_fleet, v_corp, '00595 self-test');
    INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status)
    VALUES (v_fleet, '00595 self-test', '+5350000595', 'pending_signup'),
           (v_fleet, '00595 self-test', '50000595', 'approved');

    CREATE TEMP TABLE t00595_signup (id uuid, phone text);
    CREATE TRIGGER t00595_signup AFTER INSERT ON pg_temp.t00595_signup
      FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();
    INSERT INTO pg_temp.t00595_signup (id, phone) VALUES (v_user, '+5350000595');

    SELECT count(*) INTO v_linked
    FROM public.fleet_members
    WHERE fleet_id = v_fleet AND driver_id = v_user
      AND status = 'active' AND signed_up_at IS NOT NULL;
    RAISE EXCEPTION '00595 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00595 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_linked IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '00595: the signup trigger linked % of the 2 matching invitations', v_linked;
  END IF;
  RAISE NOTICE '00595: verified, a signup with 2 matching invitations links both';
END $$;
