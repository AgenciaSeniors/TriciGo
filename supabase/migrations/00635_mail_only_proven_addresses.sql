-- 00635: e-mail an account only at an address its owner proved, cap and shorten what a
-- trusted contact gets, and cap send_gift.
--
-- The hole (verified against prod on 2026-10-07). public.users.email is written
-- UNVERIFIED: add-email-with-verification stores the address before its owner opens
-- the confirmation link, and GoTrue's open signup copies any address in. Seven
-- SECURITY DEFINER functions mailed that address through the send-email Edge Function
-- without asking whether anyone had proved it. The cheapest abuse: account B sets
-- victim@x as its e-mail, account A gifts B 1 CUP, B gifts it back, and so on. Every
-- gift made send_driver_payout_email mail victim@x from noreply@tricigo.com with A's
-- full_name and A's gift note in it. send_gift had no cap and no note limit, and since
-- send-email v57 (2026-10-07) service-key callers skip its per-IP bucket, so nothing
-- slowed it down. The same address also received ride receipts (pickup and drop-off
-- addresses), delivery receipts, payment failures and driver status mail: a typo in
-- the profile sent the account's movements to a stranger.
--
-- The rule, in one place (public.mailable_user_emails): an account's address may be
-- mailed when
--   * its owner confirmed it (users.email_verified_at, stamped only by confirm-email;
--     00611 clears it on every change), or
--   * the account holds a Google or Apple identity whose provider-verified address is
--     the same one (case and surrounding spaces ignored).
-- Measured in prod on 2026-10-07: 284 accounts have an address, 0 have
-- email_verified_at, 156 match a Google or Apple identity Google or Apple verified.
-- With the flag alone nobody would get any of these e-mails; with the identity
-- clause the 156 keep them. The other 128 (addresses typed into the profile) get
-- them again once they confirm. A password identity proves nothing: GoTrue's signup
-- is open and autoconfirmed.
--
-- Patched in place from the LIVE bodies (pg_get_functiondef), one targeted line each,
-- so no other behaviour can be lost (the 00124 lesson). A body that no longer carries
-- the expected text aborts the migration instead of leaving that sender open. Each
-- patch is recognised as applied by a one-line marker, so a re-run with other line
-- endings (an SQL Editor paste from Windows, then db push) never patches twice:
--   own address  send_driver_payout_email (gift_received, driver_payout), apply_cargo_bonus,
--                send_first_ride_email, send_payment_failed_email, send_delivery_receipt_email,
--                send_driver_status_email, send_ride_receipt_email
--   third party  notify_trusted_contacts_on_accept / _on_complete: the rider types the
--                contact's address and nobody can prove it. Capped at 20 e-mails a day
--                per rider and address (lowercased, trimmed): per rider, so nobody can
--                use up a bucket to silence another rider's safety notice. Names reach
--                the contact as first name and initial, letters only (the rule
--                broadcast-emergency already applies), in the e-mail and in the SMS.
--   send_gift    a note of at most 500 characters (the apps' own limit) and 20 gifts a
--                day per sender. Only gifts that commit count: a refused or failed
--                gift rolls back its increment, and idempotent replays return before
--                the check. Prod has seen 8 gifts in total, at most 2 per sender a day.
--
-- mailable_user_emails is also granted to service_role so the Edge Functions that mail
-- users.email (behavioral-emails, send-bulk-email, notify-document-rejection,
-- generate-driver-contract, generate-recharge-receipt) apply the same rule. It answers
-- "is this account's address proven", so no client may call it.
--
-- The final check covers the whole catalog: any public function that reads
-- users.email and calls send-email must go through the rule, unless it is listed as
-- mailing an admin-configured address (notify_driver_under_review).
--
-- Not covered here: register-login-device still gates on email_verified_at alone.
--
-- Rehearsal: supabase/tests/00635/run.sh (RED against the live bodies; GREEN with this
-- file applied twice, plus negative proofs of its own checks).

-- 1. Helpers ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mailable_user_emails(p_user_ids uuid[])
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT u.id, btrim(u.email)
  FROM public.users u
  WHERE u.id = ANY (p_user_ids)
    AND btrim(coalesce(u.email, '')) <> ''
    AND (
      u.email_verified_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM auth.identities i
        WHERE i.user_id = u.id
          AND i.provider IN ('google', 'apple')
          AND lower(i.identity_data->>'email_verified') = 'true'
          AND lower(btrim(i.identity_data->>'email')) = lower(btrim(u.email))
      )
    );
$fn$;

COMMENT ON FUNCTION public.mailable_user_emails(uuid[]) IS
  '00635: the accounts among p_user_ids whose users.email may be mailed (confirmed through confirm-email, or the same address on a Google/Apple identity the provider verified), with the address trimmed. Every sender to users.email uses it. service_role only: it tells whether an address is proven.';

CREATE OR REPLACE FUNCTION public._user_mailable_email(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT m.email FROM public.mailable_user_emails(ARRAY[p_user_id]) m;
$fn$;

COMMENT ON FUNCTION public._user_mailable_email(uuid) IS
  '00635: users.email of p_user_id when it may be mailed (see mailable_user_emails), else NULL. For the SQL senders; no grants.';

CREATE OR REPLACE FUNCTION public._trusted_contact_email_allowed(p_rider_id uuid, p_email text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT r.allowed
  FROM public.check_rate_limit(
    'trusted-contact-email:' || p_rider_id::text || ':' || lower(btrim(p_email)), 20, 86400) r;
$fn$;

COMMENT ON FUNCTION public._trusted_contact_email_allowed(uuid, text) IS
  '00635: counts one e-mail from p_rider_id''s trip notices to a trusted contact''s address and says whether it is within 20 a day for that rider and address. No grants.';

-- A person's name as a third party may see it: first name and the initial of the next
-- word, letters only ("Ana María Pérez" -> "Ana M."). Mirror of smsPersonName in
-- supabase/functions/_shared/sos-message.ts: full_name and a contact's name are written
-- by the account, so in full they would let it put a link or its own text in mail
-- signed TriciGo. Letters are listed explicitly (ASCII and Latin-1) so the result does
-- not depend on the database locale.
CREATE OR REPLACE FUNCTION public._third_party_person_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH w AS (
    SELECT t.word, row_number() OVER (ORDER BY t.ord) AS n
    FROM (
      SELECT regexp_replace(s.word, '[^A-Za-zÀ-ÖØ-öø-ÿ''-]', '', 'g') AS word, s.ord
      FROM regexp_split_to_table(coalesce(p_name, ''), '\s+') WITH ORDINALITY AS s(word, ord)
    ) t
    WHERE t.word ~ '[A-Za-zÀ-ÖØ-öø-ÿ]'
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM w WHERE n = 2) THEN (SELECT left(word, 20) FROM w WHERE n = 1)
    ELSE (SELECT left(word, 20) FROM w WHERE n = 1) || ' ' || (SELECT upper(left(word, 1)) FROM w WHERE n = 2) || '.'
  END;
$fn$;

COMMENT ON FUNCTION public._third_party_person_name(text) IS
  '00635: first name and initial, letters only, for text that reaches someone other than the account (mirror of smsPersonName in _shared/sos-message.ts). NULL when there is no letter. No grants.';

REVOKE ALL ON FUNCTION public.mailable_user_emails(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mailable_user_emails(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public._user_mailable_email(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._trusted_contact_email_allowed(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._third_party_person_name(text) FROM PUBLIC, anon, authenticated, service_role;

-- 2. In-place patches of the live senders ------------------------------------------
-- marker: one line that only the patched body carries. It decides "already applied",
-- so the check does not depend on line endings.

DO $patch$
DECLARE
  r record;
  v_oid regprocedure;
  v_src text;
  v_n integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
    ('public.send_driver_payout_email()', 'public._user_mailable_email(',
     $o$  SELECT u.email, u.full_name, u.role::text$o$,
     $n$  SELECT public._user_mailable_email(u.id), u.full_name, u.role::text$n$),
    ('public.apply_cargo_bonus(uuid,uuid,integer)', 'public._user_mailable_email(',
     $o$    SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = p_driver_user_id LIMIT 1;$o$,
     $n$    SELECT public._user_mailable_email(u.id), u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = p_driver_user_id LIMIT 1;$n$),
    ('public.send_first_ride_email()', 'public._user_mailable_email(',
     $o$  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;$o$,
     $n$  SELECT public._user_mailable_email(u.id), u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;$n$),
    ('public.send_payment_failed_email()', 'public._user_mailable_email(',
     $o$  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;$o$,
     $n$  SELECT public._user_mailable_email(u.id), u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;$n$),
    ('public.send_delivery_receipt_email()', 'public._user_mailable_email(',
     $o$  SELECT u.email, u.full_name INTO v_customer_email, v_customer_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;$o$,
     $n$  SELECT public._user_mailable_email(u.id), u.full_name INTO v_customer_email, v_customer_name FROM users u WHERE u.id = NEW.customer_id LIMIT 1;$n$),
    ('public.send_driver_status_email()', 'public._user_mailable_email(',
     $o$  SELECT u.email, u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;$o$,
     $n$  SELECT public._user_mailable_email(u.id), u.full_name INTO v_email, v_full_name FROM users u WHERE u.id = NEW.user_id LIMIT 1;$n$),
    ('public.send_ride_receipt_email()', 'public._user_mailable_email(',
     $o$  SELECT email INTO v_customer_email FROM users WHERE id = NEW.customer_id LIMIT 1;$o$,
     $n$  SELECT public._user_mailable_email(NEW.customer_id) INTO v_customer_email;$n$),
    ('public.notify_trusted_contacts_on_accept()', 'public._trusted_contact_email_allowed(',
     $o$    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN$o$,
     $n$    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      -- 00635: the rider types this address and nobody can prove it; cap what this
      -- rider's notices send to one inbox in a day.
      CONTINUE WHEN NOT public._trusted_contact_email_allowed(NEW.customer_id, v_contact.contact_email);$n$),
    ('public.notify_trusted_contacts_on_accept()', 'public._third_party_person_name(full_name)',
     $o$  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;$o$,
     $n$  SELECT public._third_party_person_name(full_name) INTO v_rider_name FROM users WHERE id = NEW.customer_id;$n$),
    ('public.notify_trusted_contacts_on_accept()', 'public._third_party_person_name(v_contact.contact_name)',
     $o$          'contact_name', COALESCE(v_contact.contact_name, ''),$o$,
     $n$          'contact_name', COALESCE(public._third_party_person_name(v_contact.contact_name), ''),$n$),
    ('public.notify_trusted_contacts_on_complete()', 'public._trusted_contact_email_allowed(',
     $o$    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN$o$,
     $n$    IF v_contact.contact_email IS NOT NULL AND v_contact.contact_email <> '' THEN
      -- 00635: the rider types this address and nobody can prove it; cap what this
      -- rider's notices send to one inbox in a day.
      CONTINUE WHEN NOT public._trusted_contact_email_allowed(NEW.customer_id, v_contact.contact_email);$n$),
    ('public.notify_trusted_contacts_on_complete()', 'public._third_party_person_name(full_name)',
     $o$  SELECT full_name INTO v_rider_name FROM users WHERE id = NEW.customer_id;$o$,
     $n$  SELECT public._third_party_person_name(full_name) INTO v_rider_name FROM users WHERE id = NEW.customer_id;$n$),
    ('public.notify_trusted_contacts_on_complete()', 'public._third_party_person_name(v_contact.contact_name)',
     $o$          'contact_name', COALESCE(v_contact.contact_name, ''),$o$,
     $n$          'contact_name', COALESCE(public._third_party_person_name(v_contact.contact_name), ''),$n$),
    ('public.send_gift(uuid,uuid,integer,text,public.wallet_account_type,text)', 'send-gift:',
     $o$  v_from_type := COALESCE(p_from_wallet, _gift_wallet_type(p_from_user_id));$o$,
     $n$  -- 00635: every gift e-mails and pushes the recipient with the sender's name and
  -- note, so the note keeps the apps' 500-character limit and a sender gets 20
  -- gifts a day. A refused or failed gift rolls back and does not count.
  IF length(p_note) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = 'gift_note_too_long',
      MESSAGE = 'La nota del regalo no puede pasar de 500 caracteres.';
  END IF;
  IF NOT (SELECT r.allowed FROM public.check_rate_limit('send-gift:' || p_from_user_id::text, 20, 86400) r) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', DETAIL = 'gift_rate_limited',
      MESSAGE = 'Enviaste demasiados regalos hoy. Intenta de nuevo más tarde.';
  END IF;

  v_from_type := COALESCE(p_from_wallet, _gift_wallet_type(p_from_user_id));$n$)
    ) AS v(fn, marker, old_txt, new_txt)
  LOOP
    v_oid := to_regprocedure(r.fn);
    IF v_oid IS NULL THEN
      RAISE NOTICE '00635: % does not exist; nothing to patch', r.fn;
      CONTINUE;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    IF position(r.marker IN v_src) > 0 THEN
      RAISE NOTICE '00635: % already patched (%)', r.fn, r.marker;
      CONTINUE;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, r.old_txt, ''))) / length(r.old_txt);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '00635: % carries the expected text % times; refusing to patch a body this migration does not know', r.fn, v_n;
    END IF;
    EXECUTE replace(pg_get_functiondef(v_oid), r.old_txt, r.new_txt);
  END LOOP;
END
$patch$;

-- 3. Assert the end state ------------------------------------------------------------
-- Checked against the catalog, not against the loop above: a sender the loop skipped,
-- a patch applied twice or a grant left behind aborts the migration (the 00531 lesson:
-- a NOTICE is invisible through apply_migration).

DO $assert$
DECLARE
  r record;
  v_src text;
  v_role text;
  v_helper text;
  v_n integer;
BEGIN
  -- Each known patch is present exactly once.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.send_driver_payout_email()', 'public._user_mailable_email('),
      ('public.apply_cargo_bonus(uuid,uuid,integer)', 'public._user_mailable_email('),
      ('public.send_first_ride_email()', 'public._user_mailable_email('),
      ('public.send_payment_failed_email()', 'public._user_mailable_email('),
      ('public.send_delivery_receipt_email()', 'public._user_mailable_email('),
      ('public.send_driver_status_email()', 'public._user_mailable_email('),
      ('public.send_ride_receipt_email()', 'public._user_mailable_email('),
      ('public.notify_trusted_contacts_on_accept()', 'public._trusted_contact_email_allowed('),
      ('public.notify_trusted_contacts_on_accept()', 'public._third_party_person_name(full_name)'),
      ('public.notify_trusted_contacts_on_accept()', 'public._third_party_person_name(v_contact.contact_name)'),
      ('public.notify_trusted_contacts_on_complete()', 'public._trusted_contact_email_allowed('),
      ('public.notify_trusted_contacts_on_complete()', 'public._third_party_person_name(full_name)'),
      ('public.notify_trusted_contacts_on_complete()', 'public._third_party_person_name(v_contact.contact_name)'),
      ('public.send_gift(uuid,uuid,integer,text,public.wallet_account_type,text)', 'send-gift:'),
      ('public.send_gift(uuid,uuid,integer,text,public.wallet_account_type,text)', 'gift_note_too_long')
    ) AS v(fn, marker)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(r.fn);
    CONTINUE WHEN v_src IS NULL;
    v_n := (length(v_src) - length(replace(v_src, r.marker, ''))) / length(r.marker);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '00635: % carries % % times (expected once)', r.fn, r.marker, v_n;
    END IF;
  END LOOP;

  -- Every function that reads users.email and calls send-email goes through the rule,
  -- known or not. notify_driver_under_review reads it as data for the admin inbox.
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prosrc
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND position('/send-email' IN p.prosrc) > 0
      AND p.prosrc ~* 'select[^;]*\memail\M[^;]*from[[:space:]]+(public\.)?users\M'
      AND p.proname <> 'notify_driver_under_review'
  LOOP
    IF position('public._user_mailable_email(' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION '00635: % mails users.email without the proof check', r.fn;
    END IF;
  END LOOP;

  FOREACH v_helper IN ARRAY ARRAY['mailable_user_emails(uuid[])', '_user_mailable_email(uuid)',
    '_trusted_contact_email_allowed(uuid,text)', '_third_party_person_name(text)']
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, ('public.' || v_helper)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '00635: % can execute public.%', v_role, v_helper;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.mailable_user_emails(uuid[])'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '00635: service_role cannot execute public.mailable_user_emails(uuid[])';
  END IF;
END
$assert$;
