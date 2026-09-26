-- ============================================================
-- 00598: link fleet invitations to people who already have an account
--
-- A fleet invitation (fleet_members) is linked to a driver only when that
-- person SIGNS UP: auto_link_fleet_member_on_signup() runs AFTER INSERT ON
-- public.users. When the admin approves an invitation for someone who already
-- has an account, nothing looks for that account. The row stays 'approved'
-- with driver_id NULL for good, the fleet's corporate rides never reach that
-- driver (find_best_drivers and accept_ride_v2 require status 'active' and a
-- driver_id), and the driver app shows the "create your own fleet" form. The
-- admin path meant for this, relink_fleet_member_for_existing_driver(), has no
-- caller (fleetService.relinkExistingDriver is unused). An account that gets
-- its phone after the approval (Google/Apple sign-in, then link-phone) is
-- stuck the same way. Reproduced locally with the live bodies and RLS on.
-- fleet_members, driver_fleets and corporate_accounts had 0 rows in prod on
-- 2026-09-25, so nobody was hit.
--
-- Who gets linked (owner decision, 2026-09-25): the one ACTIVE account whose
-- number is confirmed by OTP in auth.users (phone_confirmed_at), not whoever
-- has it in public.users.phone. That column is writable by its owner through
-- PostgREST without an OTP (column UPDATE grant plus users_update_own, and
-- tg_users_protect_admin_fields does not cover it), and it is not unique.
-- auth.users.phone is unique (users_phone_key) and GoTrue keeps it as E.164
-- digits without '+'. On 2026-09-25, 544 of the 546 phones in public.users
-- equal (normalized) their confirmed auth phone; the other 2 belong to seeded
-- admins with no auth phone. The one number two accounts share (an admin,
-- unconfirmed, and a driver, confirmed) resolves to the driver. No driver
-- profile is required, same as signup: a passenger-only account is linked and
-- is already in the fleet when it registers as a driver.
--
-- Fix:
--   1. _user_id_by_verified_phone(text) returns that account's id, or NULL.
--      It reads auth.users, so it is SECURITY DEFINER. It maps a number to an
--      account, so anon and authenticated cannot execute it.
--   2. trg_fleet_members_set_driver_on_approval, BEFORE INSERT OR UPDATE OF
--      status. When a write makes the invitation linkable (inserted as, or
--      moved into, approved / pending_signup, with no driver_id), it links the
--      row on NEW. It fires after trg_fleet_members_protect (triggers with the
--      same event and timing fire in name order), so an owner's change to
--      status has already been reverted when it looks. A row that was ALREADY
--      linkable is not looked at again: the owner can still edit driver_phone
--      after the review, and that edit must not link whoever owns the new number.
--   3. auto_link_fleet_member_on_phone_verified, AFTER UPDATE OF phone ON
--      public.users. When the new number is the one auth.users confirms for
--      this same account (link-phone confirms it there before copying it to
--      public.users), it links that account's approved invitations. The write
--      runs under app.trusted_fleet_update for the protect trigger, and the flag
--      is then put back so it does not outlive the write.
--   4. A one-time backfill for invitations already approved whose number a
--      verified account holds (0 rows in prod).
-- The signup trigger, the relink RPC and the protect trigger are untouched.
-- The migration asserts its result instead of trusting CREATE (a plpgsql body
-- is only checked when it runs): a rolled-back self-test against a real
-- verified account, and the ACL of the new functions.
-- Rehearsal: supabase/tests/00598/run.sh.
-- ============================================================

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
  IF NEW.driver_id IS NOT NULL OR NEW.status NOT IN ('approved', 'pending_signup') THEN
    RETURN NEW;
  END IF;
  -- Only when this write makes the invitation linkable. A row that already was
  -- is left alone: the owner can still edit driver_phone after the review.
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
DROP TRIGGER IF EXISTS trg_fleet_members_set_driver_on_approval ON public.fleet_members;
CREATE TRIGGER trg_fleet_members_set_driver_on_approval
  BEFORE INSERT OR UPDATE OF status ON public.fleet_members
  FOR EACH ROW EXECUTE FUNCTION public.tg_fleet_members_set_driver_on_approval();

-- 3. Link when an account verifies its number later ------------------------------
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_phone_verified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev_flag text;
BEGIN
  -- A number written into users.phone without an OTP links nothing: it has
  -- to be the one auth.users confirms for this same account.
  IF public._user_id_by_verified_phone(NEW.phone) IS DISTINCT FROM NEW.id THEN
    RETURN NEW;
  END IF;

  -- The caller can be the account itself (the app copies the phone under its
  -- own JWT), so tell tg_fleet_members_protect this write is trusted, then put
  -- the flag back so it does not outlive this write.
  v_prev_flag := current_setting('app.trusted_fleet_update', true);
  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE public.fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  PERFORM set_config('app.trusted_fleet_update', COALESCE(v_prev_flag, ''), true);
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_verified() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_link_fleet_member_on_phone_verified() TO service_role;

DROP TRIGGER IF EXISTS auto_link_fleet_member_on_phone_verified ON public.users;
CREATE TRIGGER auto_link_fleet_member_on_phone_verified
  AFTER UPDATE OF phone ON public.users
  FOR EACH ROW
  WHEN (NEW.phone IS NOT NULL AND NEW.phone IS DISTINCT FROM OLD.phone)
  EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_verified();

-- 4. Invitations approved before this migration (0 rows in prod) ----------------
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

-- 5. Assert the result ------------------------------------------------------------
-- Against a real account with a confirmed number: an invitation approved for it
-- is linked by the approval, and an approved invitation the approval could not
-- link (it carried no phone yet) is linked when the account's phone is updated
-- (the trigger function fired from a scratch table, so no real row changes).
-- Everything the block does is rolled back. A database with no verified
-- account has nobody to link, so the behaviour check is skipped there. The ACL
-- check always runs.
DO $$
DECLARE
  v_user        uuid;
  v_phone       text;
  v_corp        uuid := gen_random_uuid();
  v_fleet       uuid := gen_random_uuid();
  v_approval    uuid := gen_random_uuid();
  v_later       uuid := gen_random_uuid();
  v_on_approval text;
  v_on_phone    text;
BEGIN
  SELECT u.id, au.phone INTO v_user, v_phone
  FROM auth.users au
  JOIN public.users u ON u.id = au.id
  WHERE au.phone ~ '^53[0-9]{8}$'
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

      -- An approved invitation that had no phone when it was approved, then
      -- the account's phone update.
      INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status)
      VALUES (v_later, v_fleet, '00598 self-test', '00598 self-test', 'approved');
      UPDATE public.fleet_members SET driver_phone = '+' || v_phone WHERE id = v_later;
      CREATE TEMP TABLE t00598_phone (id uuid, phone text);
      CREATE TRIGGER t00598_phone AFTER UPDATE ON pg_temp.t00598_phone
        FOR EACH ROW EXECUTE FUNCTION public.auto_link_fleet_member_on_phone_verified();
      INSERT INTO pg_temp.t00598_phone (id, phone) VALUES (v_user, NULL);
      UPDATE pg_temp.t00598_phone SET phone = '+' || v_phone;
      SELECT status || ':' || coalesce((driver_id = v_user)::text, 'unlinked') INTO v_on_phone
      FROM public.fleet_members WHERE id = v_later;

      RAISE EXCEPTION '00598 self-test rollback';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> '00598 self-test rollback' THEN
        RAISE;
      END IF;
    END;

    IF v_on_approval IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: approving an invitation for a verified account left it %', coalesce(v_on_approval, 'missing');
    END IF;
    IF v_on_phone IS DISTINCT FROM 'active:true' THEN
      RAISE EXCEPTION '00598: verifying the phone left its approved invitation %', coalesce(v_on_phone, 'missing');
    END IF;
    RAISE NOTICE '00598: verified, approval and phone verification both link the confirmed account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['public._user_id_by_verified_phone(text)',
                      'public.tg_fleet_members_set_driver_on_approval()',
                      'public.auto_link_fleet_member_on_phone_verified()']) AS f(sig),
         unnest(ARRAY['anon', 'authenticated']) AS r(role_name)
    WHERE has_function_privilege(r.role_name, f.sig::regprocedure, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION '00598: a new function is executable by anon or authenticated';
  END IF;
END $$;
