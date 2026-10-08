-- 00640: let an account ask whether ITS e-mail address is proven, so the apps can tell
-- it to confirm the address (spec: docs/superpowers/specs/2026-10-08-email-confirm-notice-design.md).
--
-- Since 00635 TriciGo mails users.email only when its owner proved it: email_verified_at
-- is set (confirm-email), or a Google/Apple identity the provider verified carries the
-- same address. Measured 2026-10-07: 128 accounts have an address that is not proven, and
-- none has ever been confirmed through the link (email_verification_tokens is empty). No
-- screen could tell them, because mailable_user_emails is service_role only: it says
-- whether ANY address is proven.
--
-- get_my_email_status() answers that for the caller only (auth.uid(), no arguments):
--   email        users.email trimmed, or NULL when empty or the phone-OTP placeholder
--   status       'none' (no real address), 'proven' (the 00635 rule), else 'unconfirmed'
--   link_sent_at newest unused, unexpired confirmation token for that address, else NULL
-- It reuses _user_mailable_email, so there is no second copy of "what counts as proven".
-- Without a session, or without a users row, it returns no rows.
--
-- Rehearsal: supabase/tests/00640/run.sh (RED without it, GREEN with it applied twice).

CREATE OR REPLACE FUNCTION public.get_my_email_status()
RETURNS TABLE (email text, status text, link_sent_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  WITH me AS (
    SELECT u.id,
           CASE
             WHEN btrim(coalesce(u.email, '')) = '' THEN NULL
             WHEN btrim(u.email) ~* '^phone_[0-9]+@tricigo\.app$' THEN NULL
             ELSE btrim(u.email)
           END AS addr
    FROM public.users u
    WHERE u.id = auth.uid()
  )
  SELECT me.addr,
         CASE
           WHEN me.addr IS NULL THEN 'none'
           WHEN public._user_mailable_email(me.id) IS NOT NULL THEN 'proven'
           ELSE 'unconfirmed'
         END,
         (SELECT max(t.created_at)
            FROM public.email_verification_tokens t
           WHERE t.user_id = me.id
             AND t.used_at IS NULL
             AND t.expires_at > now()
             AND lower(btrim(t.email)) = lower(me.addr))
  FROM me;
$fn$;

COMMENT ON FUNCTION public.get_my_email_status() IS
  '00640: the caller''s users.email (NULL when empty or the phone placeholder), whether it is proven (00635 rule: none/unconfirmed/proven) and when the newest still-valid confirmation link was sent. About auth.uid() only.';

REVOKE ALL ON FUNCTION public.get_my_email_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_email_status() TO authenticated, service_role;

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.get_my_email_status()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00640: anon can execute public.get_my_email_status()';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_my_email_status()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00640: authenticated cannot execute public.get_my_email_status()';
  END IF;
END
$assert$;
