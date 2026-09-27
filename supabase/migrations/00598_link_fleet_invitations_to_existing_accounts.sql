-- ============================================================
-- 00598: link fleet invitations to people who already have an account
--
-- A fleet invitation (fleet_members) was linked to a driver only when that
-- person SIGNED UP: auto_link_fleet_member_on_signup() runs AFTER INSERT ON
-- public.users. When the admin approves an invitation for someone who already
-- has an account, nothing looks for that account. The row stays 'approved'
-- with driver_id NULL for good, the fleet's corporate rides never reach that
-- driver (find_best_drivers and accept_ride_v2 require status 'active' and a
-- driver_id), and the driver app shows the "create your own fleet" form. The
-- admin path meant for this, relink_fleet_member_for_existing_driver(), has no
-- caller (fleetService.relinkExistingDriver is unused). An account that
-- confirms its phone after the approval (Google/Apple sign-in, then
-- link-phone) is stuck the same way. Reproduced locally with the live bodies
-- and RLS on. fleet_members, driver_fleets and corporate_accounts had 0 rows
-- in prod on 2026-09-25, so nobody was hit.
--
-- Rule (owner decisions, 2026-09-25): an invitation is linked to the one
-- ACTIVE account whose number is confirmed by OTP in auth.users
-- (phone_confirmed_at), at each moment that can make that true: approval,
-- signup and confirmation. public.users.phone is not proof. Its owner can
-- write any number there through PostgREST without an OTP (column UPDATE
-- grant, users_update_own, and tg_users_protect_admin_fields does not cover
-- it), and it is not unique. auth.users.phone is unique (users_phone_key),
-- GoTrue keeps it as E.164 digits without '+', and no end user can write it.
-- phone_autoconfirm is false in prod (/auth/v1/settings, 2026-09-25), and
-- verify-otp and link-phone confirm a number with the admin API only after
-- checking the D7 code. That is an invariant to keep: every admin-API write
-- that sets phone_confirm must follow an OTP of that number. (GoTrue's
-- updateUserById confirms before it sets the new phone, so an account whose
-- current number was never confirmed would have that number counted too; no
-- account with a session has an unconfirmed number today.) On 2026-09-25,
-- 544 of the 546 phones in public.users equal (normalized) their confirmed
-- auth phone; the other 2 belong to seeded admins with no auth phone. The one
-- number two accounts share (an admin, unconfirmed, and a driver, confirmed)
-- resolves to the driver. No driver profile is required, same as signup: a
-- passenger-only account is linked and is already in the fleet when it
-- registers as a driver.
--
-- Fix:
--   1. _user_id_by_verified_phone(text) returns that account's id, or NULL
--      (never a guess between two). It reads auth.users, so it is SECURITY
--      DEFINER; it maps a number to an account, so clients cannot execute it.
--   2. Approval: trg_fleet_members_set_driver_on_approval, BEFORE INSERT OR
--      UPDATE OF status ON fleet_members, links the row on NEW when the write
--      makes it linkable (inserted as, or moved into, approved or
--      pending_signup, with no driver_id). A row that already was linkable is
--      not looked at again, so a later edit of an approved invitation (the
--      owner can still change driver_phone after the review) links nobody
--      here. It fires after trg_fleet_members_protect (same event and timing
--      fire in name order) and so sees the row after an owner's change of
--      status was reverted. That is defence in depth: the protect trigger
--      reverts every field this one sets, whichever runs first.
--   3. Confirmation: on_auth_user_phone_confirmed, AFTER UPDATE ON auth.users,
--      links an account's approved invitations when a number becomes
--      confirmed for it: its first confirmation, or a new number on an
--      account already confirmed. That is where new accounts get linked in
--      practice: verify-otp's createUser INSERTs the account and confirms the
--      number in a second statement, and link-phone and verify-otp's heal call
--      updateUserById, which confirms first and sets the phone after.
--      Re-confirming the same number does not count. The trigger names no
--      column and has no WHEN, so GoTrue can still alter phone or
--      phone_confirmed_at; the function returns at once for any other update.
--      postgres does not own auth.users and cannot drop or disable a trigger
--      on it: to switch this one off, replace the function body with
--      RETURN NEW.
--   4. Signup: auto_link_fleet_member_on_signup now links only a confirmed
--      number. handle_new_user copies auth.users.phone whether or not it is,
--      and GoTrue's own phone signup (the provider is on) inserts the account
--      before its OTP. Since GoTrue inserts before it confirms, this path only
--      links an account inserted already confirmed; step 3 links the rest.
--   5. The signup and confirmation functions run inside GoTrue's transaction.
--      A failure to link, including a lock wait over 2s, becomes a WARNING
--      plus a row in rpc_attempt_log (outcome 'link_failed'), and never fails
--      the signup, the login or the confirmation.
--   6. Numbers outside Cuba: GoTrue stores them without '+', so both
--      functions put the '+' back before they look the number up.
--   7. A one-time backfill for invitations already approved whose number a
--      verified account holds (0 rows in prod).
-- The relink RPC and the protect trigger are untouched.
-- The migration asserts its result instead of trusting CREATE (a plpgsql
-- body is only checked when it runs): a rolled-back self-test against a real
-- verified account (approval, signup and confirmation each link it), and the
-- ACL of the four functions. The trigger on auth.users is created last, so
-- the lock it takes on that table is held for the shortest time.
-- Rehearsal: supabase/tests/00598/run.sh and supabase/tests/00598/mutants.py.
-- ============================================================

SET lock_timeout = '5s';

-- 1. The account that confirmed a number ---------------------------------------
CREATE OR REPLACE FUNCTION public._user_id_by_verified_phone(p_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_norm text := public._normalize_cuban_phone(p_phone);
  v_id   uuid;
BEGIN
  IF v_norm IS NULL OR v_norm !~ '^\+[0-9]{8,15}$' THEN
    RETURN NULL;
  END IF;

  -- GoTrue stores E.164 without '+'; both spellings use users_phone_key.
  -- Anything but exactly one match returns NULL: never guess.
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END
    INTO v_id
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone IN (v_norm, substr(v_norm, 2))
    AND au.phone_confirmed_at IS NOT NULL
    AND u.is_active;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public._user_id_by_verified_phone(text) IS
  'The one active account whose number is confirmed by OTP in auth.users (phone_confirmed_at), or NULL. public.users.phone is not proof: its owner can write it without an OTP. Maps a number to an account, so clients cannot execute it.';

REVOKE EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) TO service_role;

-- 2. Link when the invitation is approved --------------------------------------
CREATE OR REPLACE FUNCTION public.tg_fleet_members_set_driver_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_driver uuid;
BEGIN
  IF NEW.driver_id IS NOT NULL OR NEW.status IS NULL
     OR NEW.status NOT IN ('approved', 'pending_signup') THEN
    RETURN NEW;
  END IF;
  -- Only when this write makes the invitation linkable. A row that already
  -- was is left alone: a later edit of an approved invitation links nobody.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('approved', 'pending_signup') THEN
      RETURN NEW;
    END IF;
  END IF;

  v_driver := public._user_id_by_verified_phone(NEW.driver_phone);
  IF v_driver IS NOT NULL THEN
    NEW.driver_id    := v_driver;
    NEW.status       := 'active';
    NEW.signed_up_at := COALESCE(NEW.signed_up_at, now());
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_fleet_members_set_driver_on_approval() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_fleet_members_set_driver_on_approval() TO service_role;

-- Fires after trg_fleet_members_protect: 'set_…' sorts after 'protect'.
CREATE OR REPLACE TRIGGER trg_fleet_members_set_driver_on_approval
  BEFORE INSERT OR UPDATE OF status ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_set_driver_on_approval();

-- 3. Link at signup, only a confirmed number ------------------------------------
-- Same trigger on public.users (AFTER INSERT) and same ACL as 00595; the body
-- adds the confirmed-number check and never lets a failure reach the signup.
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_phone text;
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  -- Runs inside GoTrue's signup transaction: failing to link must never fail
  -- the signup. lock_timeout turns a lock wait into an error caught here.
  BEGIN
    -- Only a number this account confirmed by OTP. GoTrue inserts accounts
    -- before confirming them, so in practice on_auth_user_phone_confirmed
    -- links them; this covers an account inserted already confirmed.
    v_phone := '+' || ltrim(NEW.phone, '+');
    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;

    PERFORM set_config('app.trusted_fleet_update', '1', true);

    UPDATE fleet_members
    SET driver_id = NEW.id,
        status = 'active',
        signed_up_at = now()
    WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(v_phone)
      AND status IN ('approved', 'pending_signup')
      AND driver_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_signup(%): % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_signup', NULL, NEW.id, 'link_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_signup() TO service_role;

-- 4. Link when an account confirms a number ------------------------------------
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_phone_confirmed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_phone text;
BEGIN
  -- Fires on every update of auth.users. Only a number that just became
  -- confirmed for this account counts: its first confirmation, or a new
  -- number on an account already confirmed.
  IF NEW.phone IS NULL OR NEW.phone = '' OR NEW.phone_confirmed_at IS NULL
     OR NOT (OLD.phone_confirmed_at IS NULL OR NEW.phone IS DISTINCT FROM OLD.phone) THEN
    RETURN NEW;
  END IF;

  -- Runs inside GoTrue's transaction (link-phone, verify-otp, GoTrue's own
  -- OTP): failing to link must never fail the login or the confirmation.
  -- lock_timeout turns a lock wait into an error caught here. GoTrue's
  -- connection carries no JWT, so tg_fleet_members_protect lets this through.
  BEGIN
    v_phone := '+' || ltrim(NEW.phone, '+');   -- GoTrue keeps E.164 without '+'
    IF public._user_id_by_verified_phone(v_phone) IS DISTINCT FROM NEW.id THEN
      RETURN NEW;
    END IF;

    UPDATE public.fleet_members fm
    SET driver_id = NEW.id,
        status = 'active',
        signed_up_at = COALESCE(fm.signed_up_at, now())
    WHERE public._normalize_cuban_phone(fm.driver_phone) = public._normalize_cuban_phone(v_phone)
      AND fm.status IN ('approved', 'pending_signup')
      AND fm.driver_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'auto_link_fleet_member_on_phone_confirmed(%): % %', NEW.id, SQLSTATE, SQLERRM;
    PERFORM public.log_rpc_attempt('auto_link_fleet_member_on_phone_confirmed', NULL, NEW.id, 'link_failed',
      jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM));
  END;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_confirmed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_confirmed() TO service_role;

-- 5. Invitations approved before this migration (0 rows in prod) ----------------
-- A migration runs with no JWT, so tg_fleet_members_protect lets it through.
UPDATE public.fleet_members fm
SET driver_id = m.user_id,
    status = 'active',
    signed_up_at = COALESCE(fm.signed_up_at, now())
FROM (
  SELECT id, public._user_id_by_verified_phone(driver_phone) AS user_id
  FROM public.fleet_members
  WHERE status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
) m
WHERE fm.id = m.id
  AND m.user_id IS NOT NULL;

-- 6. Assert the result ------------------------------------------------------------
-- Against a real account with a confirmed number: an invitation approved for it
-- is linked by the approval; two approved invitations the approval could not
-- link (they carried no phone yet) are linked by a signup and by a
-- confirmation of that number. The signup and confirmation functions are
-- fired from scratch tables, so no account row is written, and everything the
-- block does is rolled back. A database with no verified account has nobody
-- to link, so the behaviour check is skipped there. The ACL check always runs.
DO $$
DECLARE
  v_user        uuid;
  v_phone       text;   -- the confirmed number as GoTrue keeps it: 53 + 8 digits
  v_corp        uuid := gen_random_uuid();
  v_fleet       uuid := gen_random_uuid();
  v_approval    uuid := gen_random_uuid();
  v_signup      uuid := gen_random_uuid();
  v_confirm     uuid := gen_random_uuid();
  v_on_approval text;
  v_on_signup   text;
  v_on_confirm  text;
BEGIN
  SELECT u.id, au.phone INTO v_user, v_phone
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone ~ '^53[56][0-9]{7}$'
    AND au.phone_confirmed_at IS NOT NULL
    AND u.is_active
  ORDER BY u.created_at, u.id
  LIMIT 1;

  IF v_user IS NULL THEN
    RAISE NOTICE '00598: no account with a confirmed phone yet, behaviour self-test skipped';
  ELSE
    BEGIN
      INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by)
      VALUES (v_corp, '00598 self-test', '+' || v_phone, v_user);
      INSERT INTO public.driver_fleets (id, corporate_account_id, name)
      VALUES (v_fleet, v_corp, '00598 self-test');

      -- Approval of an invitation carrying the number as 8 local digits.
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status)
      VALUES (v_approval, v_fleet, '00598 self-test', substr(v_phone, 3), 'pending_review');
      UPDATE public.fleet_members SET status = 'approved' WHERE id = v_approval;
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_approval
      FROM public.fleet_members WHERE id = v_approval;

      -- Two approved invitations with no phone yet, so the approval links neither.
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status)
      VALUES (v_signup, v_fleet, '00598 self-test', '00598 self-test signup', 'approved'),
             (v_confirm, v_fleet, '00598 self-test', '00598 self-test confirmation', 'approved');

      -- Signup: point the first one at the number, then fire the signup function.
      UPDATE public.fleet_members SET driver_phone = v_phone WHERE id = v_signup;
      CREATE TEMP TABLE t00598_signup (id uuid, phone text);
      CREATE TRIGGER t00598_signup AFTER INSERT ON pg_temp.t00598_signup
        FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_signup();
      INSERT INTO pg_temp.t00598_signup (id, phone) VALUES (v_user, '+' || v_phone);
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_signup
      FROM public.fleet_members WHERE id = v_signup;

      -- Confirmation: point the second one at the number, then fire the
      -- confirmation function as the update that confirms the account's number.
      UPDATE public.fleet_members SET driver_phone = '+' || v_phone WHERE id = v_confirm;
      CREATE TEMP TABLE t00598_auth (id uuid, phone text, phone_confirmed_at timestamptz);
      CREATE TRIGGER t00598_auth AFTER UPDATE ON pg_temp.t00598_auth
        FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_confirmed();
      INSERT INTO pg_temp.t00598_auth (id, phone, phone_confirmed_at) VALUES (v_user, v_phone, NULL);
      UPDATE pg_temp.t00598_auth SET phone_confirmed_at = now();
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_confirm
      FROM public.fleet_members WHERE id = v_confirm;

      RAISE EXCEPTION '00598 self-test rollback';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '00598 self-test rollback' THEN
        RAISE;
      END IF;
    END;

    IF v_on_approval IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: approving an invitation for a verified account left it %', coalesce(v_on_approval, 'missing');
    END IF;
    IF v_on_signup IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: signing up with a verified number left the invitation %', coalesce(v_on_signup, 'missing');
    END IF;
    IF v_on_confirm IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: confirming the number left the approved invitation %', coalesce(v_on_confirm, 'missing');
    END IF;
    RAISE NOTICE '00598: verified, approval, signup and confirmation each link the confirmed account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['public._user_id_by_verified_phone(text)',
                      'public.tg_fleet_members_set_driver_on_approval()',
                      'public.auto_link_fleet_member_on_signup()',
                      'public.auto_link_fleet_member_on_phone_confirmed()']) AS f(sig),
         unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
    WHERE has_function_privilege(r.role_name, f.sig::regprocedure, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION '00598: a fleet-linking function is executable by anon or authenticated';
  END IF;
END $$;

-- 7. The confirmation trigger, last: CREATE TRIGGER blocks writes to auth.users
-- until this migration commits, so the window stays as short as possible. No
-- column list and no WHEN: they would stop GoTrue from altering those columns.
CREATE OR REPLACE TRIGGER on_auth_user_phone_confirmed
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_confirmed();

RESET lock_timeout;
