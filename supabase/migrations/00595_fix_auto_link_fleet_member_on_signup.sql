-- ============================================================
-- 00595: a signup fails when two fleet invitations match its phone
--
-- auto_link_fleet_member_on_signup() runs AFTER INSERT ON public.users and
-- links the new user to the fleet invitations waiting for their phone.
-- Since 00246 its UPDATE ends in `RETURNING id INTO v_member_id`. In
-- PL/pgSQL an INSERT/UPDATE/DELETE ... RETURNING ... INTO raises
-- TOO_MANY_ROWS (P0003, "query returned more than one row") as soon as the
-- statement touches two or more rows, STRICT or not. Neither this function
-- nor handle_new_user(), which inserts the users row for every new auth
-- user, has an EXCEPTION block, so the error rolls back the whole signup.
-- Every retry meets the same invitations: that phone number cannot sign up.
--
-- The schema allows two matches. fleet_members is unique on (fleet_id,
-- driver_phone), the RAW phone, while the UPDATE compares
-- _normalize_cuban_phone() of both sides (00461). Two fleets inviting the
-- same person is enough, and so is one fleet holding the number in two
-- formats ('+5351234567' and '51234567').
--
-- No impact yet: fleet_members had 0 rows on 2026-09-25. This is the latent
-- case that the RETURNING ... INTO sweep after 00594 turned up.
--
-- Behaviour kept: the signup links EVERY matching invitation. That is what
-- the UPDATE does once the error is gone, what 00246 promised ("If the
-- user's phone matches any approved fleet_member, we link them"), and what
-- relink_fleet_member_for_existing_driver(), the admin path for drivers who
-- registered before their fleet was approved, has always done with the same
-- WHERE clause. Linking only one would not avoid two memberships: that
-- relink would link the rest later. Both matching statuses are set by an
-- admin (tg_fleet_members_protect forces an owner's insert to
-- pending_review), and 00246 says the admin should reject a phone that is
-- already in another fleet. The server copes with two memberships: no
-- constraint limits a driver to one fleet, accept_ride_v2 and
-- find_best_drivers test membership with EXISTS per corporate account, and
-- commission rates come from corporate_accounts, never from fleet_members.
-- The driver app does not: fleetService.getMembershipForDriver() reads with
-- .maybeSingle(), gets an error for two rows and returns null, so the
-- corporate screen offers to create a fleet instead of showing the
-- driver's own. That is a display problem, for a separate JS-only fix in
-- the app, and still better than a signup that fails.
--
-- Fix: drop the RETURNING ... INTO and the variable it filled, which nothing
-- read. No count is needed, so no GET DIAGNOSTICS either. Everything else is
-- the live definition read with pg_get_functiondef on 2026-09-25
-- (md5(prosrc) 0b74fd48e33257ba39bd719376d1a732, length 494; identical to
-- 00461): same signature, SECURITY DEFINER, search_path, empty-phone guard,
-- trusted-fleet flag (00435) and normalized match. CREATE OR REPLACE keeps
-- the trigger and the live ACL (postgres and service_role only); the
-- REVOKE/GRANT restate the ACL for a fresh database.
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

-- Assert the fix instead of trusting the CREATE: a plpgsql body is not
-- checked until it runs, and this bug only shows when two invitations match.
-- Firing the real trigger would need a users row, and users.id references
-- auth.users. So the check reads the body just stored back from pg_proc and
-- runs it as a temporary trigger function whose search_path resolves
-- fleet_members to a temporary copy of the table (this relies on the body
-- naming fleet_members without a schema, as it does): two invitations for
-- one person, in two formats, then one signup; both must end up linked. The
-- block is rolled back, trusted-fleet flag included. If the body still
-- raised TOO_MANY_ROWS, that error is not the one caught here, so it would
-- abort the migration.
DO $$
DECLARE
  v_src    text;
  v_user   uuid := gen_random_uuid();
  v_linked integer;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_catalog.pg_proc p
  WHERE p.oid = 'public.auto_link_fleet_member_on_signup()'::pg_catalog.regprocedure;

  BEGIN
    CREATE TEMP TABLE fleet_members (LIKE public.fleet_members INCLUDING DEFAULTS);
    CREATE TEMP TABLE signups_00595 (id uuid, phone text);
    -- pg_temp FIRST, the reverse of the live function's 'public', 'pg_temp'.
    -- With pg_temp listed, its position decides, and this order is what
    -- sends the body's fleet_members to the temp copy. The live order here
    -- would run the test against the real table.
    EXECUTE pg_catalog.format(
      'CREATE FUNCTION pg_temp.auto_link_00595() RETURNS trigger LANGUAGE plpgsql '
      'SET search_path TO pg_temp, public AS %L', v_src);
    CREATE TRIGGER auto_link_00595 AFTER INSERT ON pg_temp.signups_00595
      FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_link_00595();

    INSERT INTO pg_temp.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES
      (gen_random_uuid(), '00595 self-test', '+5351230595', 'pending_signup'),
      (gen_random_uuid(), '00595 self-test', '51230595', 'approved');
    INSERT INTO pg_temp.signups_00595 (id, phone) VALUES (v_user, '+5351230595');

    SELECT count(*) INTO v_linked
    FROM pg_temp.fleet_members
    WHERE driver_id = v_user AND status = 'active' AND signed_up_at IS NOT NULL;

    RAISE EXCEPTION '00595 self-test rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '00595 self-test rollback' THEN
      RAISE;
    END IF;
  END;

  IF v_linked IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '00595: the signup linked % of 2 matching invitations', v_linked;
  END IF;
  RAISE NOTICE '00595: verified, one signup links both matching invitations';
END $$;
