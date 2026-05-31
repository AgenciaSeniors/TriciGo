-- ============================================================
-- 00358 — Sync user email from auth.users → public.users
-- ============================================================
--
-- BUG: Recharge receipt emails (and any feature reading
-- public.users.email) silently fail to reach users because
-- public.users.email is NULL for ~88% of users (23/26 in prod; 21 of
-- those have a valid auth.users.email).
--
-- Root cause: handle_new_user() (trigger on auth.users INSERT) copies
-- only id/phone/full_name/role — it NEVER copies the email. Users sign
-- up by phone (no email), then add an email later via OAuth, which
-- lands in auth.users.email but is never synced to public.users.email.
-- generate-recharge-receipt reads public.users.email → NULL → silently
-- skips the user's receipt (the admin copy is still sent, so Resend is
-- fine — only the user gets nothing).
--
-- Fix: (1) handle_new_user copies the email at signup; (2) a new trigger
-- syncs email on auth.users email change; (3) a one-time backfill.
--
-- Safety: public.users.email is NOT protected by
-- tg_users_protect_admin_fields (it guards role/level/status/etc.), and
-- the backfill runs with auth.uid() = NULL — the branch that returns NEW
-- unchanged — so the UPDATE passes the BEFORE-UPDATE trigger untouched.
-- ============================================================

-- 1. handle_new_user: also copy the email at signup (NULL for phone-only
--    signups; the sync trigger below fills it in when added later).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  INSERT INTO public.users (id, phone, full_name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.phone, ''),
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    NEW.email,
    'customer'
  );
  RETURN NEW;
END;
$$;

-- 2. Keep public.users.email in sync when the auth email changes (e.g. a
--    phone-signup user later adds/changes their email via OAuth/email).
CREATE OR REPLACE FUNCTION public.sync_user_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
    UPDATE public.users SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_change ON auth.users;
CREATE TRIGGER on_auth_user_email_change
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_email_from_auth();

-- 3. One-time backfill: copy the existing auth email into public.users
--    for every user whose public email is missing. Idempotent (only
--    touches rows where public email is NULL/'' and auth email is set).
UPDATE public.users u
SET email = au.email
FROM auth.users au
WHERE au.id = u.id
  AND (u.email IS NULL OR u.email = '')
  AND au.email IS NOT NULL;
