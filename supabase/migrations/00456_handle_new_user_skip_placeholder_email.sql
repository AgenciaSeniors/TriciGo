-- ============================================================
-- 00456 — Stop the synthetic phone-OTP placeholder email from
--          re-accumulating in public.users.email
-- ============================================================
--
-- BUG: Phone-OTP accounts get a synthetic email
-- `phone_<digits>@tricigo.app` in auth.users.email (minted by the
-- verify-otp Edge Function — it is LOAD-BEARING for login and must
-- never be removed from auth.users). Migration 00455 cleared that
-- placeholder out of public.users.email so transactional senders stop
-- emailing a non-existent address that bounces.
--
-- BUT 00358 redefined handle_new_user() + sync_user_email_from_auth()
-- to copy auth.users.email → public.users.email verbatim. For phone
-- signups verify-otp has already stamped the synthetic email into
-- auth.users.email BEFORE handle_new_user fires, so the placeholder is
-- copied straight back into public.users.email on every new signup.
-- 00455 only cleaned existing rows; it never touched these triggers, so
-- 00358 wins and the placeholder re-accumulates (verified in prod: a
-- user created after 00455 ran already had it back).
--
-- Fix: make both triggers skip the placeholder (copy NULL instead), and
-- re-null any rows that already leaked. auth.users is NOT touched.
--
-- Safety: public.users.email is NOT guarded by
-- tg_users_protect_admin_fields (it guards role/level/status), and the
-- final UPDATE runs with auth.uid() = NULL — the branch that returns NEW
-- unchanged — so it passes the BEFORE-UPDATE trigger untouched (same
-- reasoning as 00358/00455).
--
-- Placeholder pattern: ^phone_\d+@tricigo\.app$  (matches
-- isPlaceholderEmail() in @tricigo/utils — keep the regex in sync).
-- ============================================================

-- 1. handle_new_user: copy the email at signup, but NULL out the
--    synthetic phone-OTP placeholder so it never lands in public.users.
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
    CASE WHEN NEW.email ~* '^phone_\d+@tricigo\.app$' THEN NULL ELSE NEW.email END,
    'customer'
  );
  RETURN NEW;
END;
$$;

-- 2. sync_user_email_from_auth: same guard — only sync REAL emails, so a
--    later auth-email change can never re-introduce the placeholder.
CREATE OR REPLACE FUNCTION public.sync_user_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email
     AND NEW.email IS NOT NULL
     AND NEW.email !~* '^phone_\d+@tricigo\.app$' THEN
    UPDATE public.users SET email = NEW.email WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Re-null any synthetic placeholder that already leaked back into
--    public.users.email since 00455 ran. Idempotent.
UPDATE public.users
SET email = NULL
WHERE email ~* '^phone_\d+@tricigo\.app$';
