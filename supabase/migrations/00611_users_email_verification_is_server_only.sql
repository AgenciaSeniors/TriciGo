-- ============================================================
-- 00611 — users.email_verified_at means "the server confirmed THIS address"
--
-- WHY
--
-- email_verified_at is the gate for login links (send-login-email-link),
-- password resets by email (request-password-reset) and new-device alerts
-- (register-login-device). Only confirm-email is meant to set it, after the
-- owner of the mailbox redeems a token. Measured on 2026-10-06:
--  - authenticated has UPDATE on users.email and users.email_verified_at,
--    and users_update_own lets a user update their own row. So any user could
--    write any address into users.email and mark it verified themselves.
--  - Nothing reset the flag when the address changed, so an address verified
--    once stayed "verified" after the user swapped it for someone else's.
-- With that, an account could aim those mails at any inbox. 0 rows have the
-- flag set in prod today, so no data changes.
--
-- WHAT
--
-- A BEFORE UPDATE trigger on users:
--  - a change of email always clears email_verified_at (whoever writes it);
--  - a caller with a JWT who is not an admin cannot change the flag: it is
--    put back to its old value, the way tg_users_protect_admin_fields treats
--    role and level. confirm-email and add-email-with-verification write with
--    the service key (no JWT), so they keep working.
-- The closing block checks the trigger is in place.
--
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.
-- ============================================================

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.tg_users_protect_email_verification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    -- A new address is unconfirmed until confirm-email says otherwise.
    NEW.email_verified_at := NULL;
  ELSIF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
        AND auth.uid() IS NOT NULL
        AND NOT public.is_admin() THEN
    -- Only the server (confirm-email, no JWT) or an admin may set or clear it.
    NEW.email_verified_at := OLD.email_verified_at;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_users_protect_email_verification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_protect_email_verification ON public.users;
CREATE TRIGGER trg_users_protect_email_verification
  BEFORE UPDATE OF email, email_verified_at ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_email_verification();

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  v_ok boolean;
BEGIN
  SELECT t.tgenabled = 'O'
         AND (t.tgtype & 2) = 2      -- BEFORE
         AND (t.tgtype & 16) = 16    -- UPDATE
         AND (t.tgtype & 1) = 1      -- FOR EACH ROW
         AND t.tgfoid = 'public.tg_users_protect_email_verification()'::regprocedure
    INTO v_ok
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.users'::regclass
    AND t.tgname = 'trg_users_protect_email_verification'
    AND NOT t.tgisinternal;
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION '00611: trg_users_protect_email_verification is missing or not a BEFORE UPDATE row trigger';
  END IF;
END
$check$;

RESET lock_timeout;
