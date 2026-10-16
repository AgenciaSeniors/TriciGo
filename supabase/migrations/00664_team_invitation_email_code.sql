-- ============================================================
-- Migration 00664: accept a team invitation with an e-mail code
--
-- Spec: docs/superpowers/specs/2026-10-16-team-invitation-email-code-design.md
--
-- 00661 accepts an invitation only through a Google or Apple identity with the
-- invited address. This adds a second way: a 6-digit code sent to that address.
-- With it the Edge Function team-invitation-code creates the account (or sets a
-- password on the existing one) and accepts the invitation:
--
--   1. public.team_invitation_codes and public.team_invitation_code_salt, lock tables
--      (RLS on, no policies, GRANT to service_role only), and public.users.password_set_at
--      in git (prod already has it).
--   2. Helpers: _team_code_hash (HMAC of the code with the salt) and
--      _team_code_account (which account has the address, and whether a code may
--      give it the role).
--   3. For the Edge Function only (service_role): team_invitation_code_issue,
--      team_invitation_code_check, accept_team_invitation_by_code.
--   4. Permissions, 5. carriage returns out of the bodies, 6. self-checks.
--
-- Account cases (_team_code_account): new (no account has the address as its
-- sign-in address and no identity carries it), proven (a verified Google or Apple
-- identity with that address; a confirmed phone on it is the same owner's),
-- password_only (only e-mail and password), needs_google (no such proof, and a
-- phone (confirmed or not) or another identity: whoever holds it could reach the
-- panel; an address only an identity carries is needs_google too, since signing in
-- with Google would land on that account) and blocked (users.is_active false or
-- banned in GoTrue). Accepting never lowers a panel role and closes every session
-- of the account.
-- Accepting sets users.password_set_at and, when users.email is the invited
-- address, users.email_verified_at.
-- Limits: 6 digits, 10 minutes, single use, 5 attempts; 60 s between codes,
-- 5 an hour and 10 a day per invitation (rate_limits).
-- Outcomes are answers ({result: ...}), never exceptions: the Edge Function maps them.
-- Rehearsal: supabase/tests/00664/run.sh
-- ============================================================

-- 0. What this migration needs -------------------------------------------------------
DO $guard$
BEGIN
  IF to_regclass('public.team_invitations') IS NULL
     OR to_regprocedure('public._team_write_role(uuid, public.user_role)') IS NULL
     OR to_regprocedure('public._team_role_rank(text)') IS NULL THEN
    RAISE EXCEPTION '00664: needs 00661 (team_invitations, _team_write_role, _team_role_rank)';
  END IF;
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
     OR to_regprocedure('extensions.hmac(text, text, text)') IS NULL THEN
    RAISE EXCEPTION '00664: needs pgcrypto in schema extensions';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text, integer, integer)') IS NULL THEN
    RAISE EXCEPTION '00664: needs public.check_rate_limit';
  END IF;
END
$guard$;

-- 1. Tables ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_invitation_codes (
  invitation_id uuid PRIMARY KEY REFERENCES public.team_invitations (id) ON DELETE CASCADE,
  code_hash     text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at    timestamptz NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  sent_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.team_invitation_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitation_codes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_invitation_codes TO service_role;

CREATE TABLE IF NOT EXISTS public.team_invitation_code_salt (
  id   smallint PRIMARY KEY CHECK (id = 1),
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.team_invitation_code_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_invitation_code_salt FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.team_invitation_code_salt TO service_role;
INSERT INTO public.team_invitation_code_salt (id, salt)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- users.password_set_at marks a password the person chose; verify-otp reads it so a phone
-- login does not overwrite that password. Prod has had it since before git tracked it
-- (set-password-after-otp writes it): adding it only when missing takes no lock there.
DO $col$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.users'::regclass AND attname = 'password_set_at' AND NOT attisdropped) THEN
    ALTER TABLE public.users ADD COLUMN password_set_at timestamptz;
  END IF;
END
$col$;

-- 2. Helpers ---------------------------------------------------------------------------
-- The stored form of a code: HMAC-SHA256 of '<invitation id>:<code>' keyed with the salt,
-- so a copy of team_invitation_codes does not let anyone try the million codes offline.
CREATE OR REPLACE FUNCTION public._team_code_hash(p_invitation uuid, p_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT encode(extensions.hmac(p_invitation::text || ':' || p_code, s.salt, 'sha256'), 'hex')
  FROM public.team_invitation_code_salt s
  WHERE s.id = 1
$$;

-- The account whose sign-in address (auth.users.email) is p_email, and its case:
-- {case: new} or {case: proven|password_only|needs_google|blocked, user_id}. When no account
-- signs in with it but an identity carries it, that identity's account (needs_google or blocked).
-- public.users.email does not count: its owner writes it without proof.
CREATE OR REPLACE FUNCTION public._team_code_account(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_id       uuid;
  v_phone    boolean;
  v_banned   boolean;
  v_active   boolean;
  v_identity boolean := false;
BEGIN
  SELECT au.id,
         au.phone_confirmed_at IS NOT NULL OR nullif(btrim(coalesce(au.phone, '')), '') IS NOT NULL,
         coalesce(au.banned_until > now(), false)
    INTO v_id, v_phone, v_banned
  FROM auth.users au
  WHERE au.email IS NOT NULL AND lower(btrim(au.email)) = v_email
  ORDER BY au.created_at, au.id
  LIMIT 1;
  IF v_id IS NULL THEN
    -- No account signs in with the address, but an identity may carry it: signing in with
    -- Google would land on that account, so a second account with the address must not be made.
    SELECT i.user_id INTO v_id
    FROM auth.identities i
    WHERE lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email
    ORDER BY i.user_id
    LIMIT 1;
    IF v_id IS NULL THEN
      RETURN jsonb_build_object('case', 'new');
    END IF;
    v_identity := true;
    SELECT coalesce(au.banned_until > now(), false) INTO v_banned FROM auth.users au WHERE au.id = v_id;
  END IF;

  SELECT coalesce(u.is_active, true) INTO v_active FROM public.users u WHERE u.id = v_id;
  IF coalesce(v_banned, false) OR NOT coalesce(v_active, true) THEN
    RETURN jsonb_build_object('case', 'blocked', 'user_id', v_id);
  END IF;
  IF v_identity THEN
    RETURN jsonb_build_object('case', 'needs_google', 'user_id', v_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = v_id
      AND i.provider IN ('google', 'apple')
      AND lower(btrim(coalesce(i.identity_data->>'email', ''))) = v_email
      AND lower(coalesce(i.identity_data->>'email_verified', '')) = 'true'
  ) THEN
    RETURN jsonb_build_object('case', 'proven', 'user_id', v_id);
  END IF;

  IF coalesce(v_phone, false) OR EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = v_id AND i.provider <> 'email'
  ) THEN
    RETURN jsonb_build_object('case', 'needs_google', 'user_id', v_id);
  END IF;
  RETURN jsonb_build_object('case', 'password_only', 'user_id', v_id);
END;
$$;

-- 3. For the Edge Function -----------------------------------------------------------
-- A new code for a pending invitation. Answers {result: issued, code, email, full_name,
-- account_exists, expires_in_s} or {result: not_found|canceled|used|expired|
-- internal_address|cooldown|too_many_hour|too_many_day[, retry_after_s]}.
CREATE OR REPLACE FUNCTION public.team_invitation_code_issue(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv   public.team_invitations;
  v_prev  public.team_invitation_codes;
  v_limit record;
  v_bytes bytea;
  v_n     bigint;
  v_code  text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
    RETURN jsonb_build_object('result', 'internal_address');
  END IF;

  SELECT * INTO v_prev FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
  IF FOUND AND v_prev.sent_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('result', 'cooldown',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_prev.sent_at + interval '60 seconds' - now()))))::integer);
  END IF;
  SELECT * INTO v_limit FROM public.check_rate_limit('team-code-hour:' || v_inv.id::text, 5, 3600);
  IF NOT v_limit.allowed THEN
    RETURN jsonb_build_object('result', 'too_many_hour',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_limit.reset_at - now()))))::integer);
  END IF;
  SELECT * INTO v_limit FROM public.check_rate_limit('team-code-day:' || v_inv.id::text, 10, 86400);
  IF NOT v_limit.allowed THEN
    RETURN jsonb_build_object('result', 'too_many_day',
      'retry_after_s', greatest(1, ceil(extract(epoch FROM (v_limit.reset_at - now()))))::integer);
  END IF;

  -- 4 random bytes; values from 4,294,000,000 up are dropped so all million codes are equally likely.
  LOOP
    v_bytes := extensions.gen_random_bytes(4);
    v_n := (get_byte(v_bytes, 0)::bigint << 24) + (get_byte(v_bytes, 1)::bigint << 16)
         + (get_byte(v_bytes, 2)::bigint << 8) + get_byte(v_bytes, 3)::bigint;
    EXIT WHEN v_n < 4294000000;
  END LOOP;
  v_code := lpad((v_n % 1000000)::text, 6, '0');

  INSERT INTO public.team_invitation_codes (invitation_id, code_hash, expires_at, attempts, sent_at)
  VALUES (v_inv.id, public._team_code_hash(v_inv.id, v_code), now() + interval '10 minutes', 0, now())
  ON CONFLICT (invitation_id) DO UPDATE
    SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at;

  RETURN jsonb_build_object(
    'result', 'issued',
    'code', v_code,
    'email', v_inv.email,
    'full_name', coalesce(v_inv.full_name, ''),
    'account_exists', (public._team_code_account(v_inv.email)->>'case') <> 'new',
    'expires_in_s', 600);
END;
$$;

-- Checks a code. Right: deletes it (single use) and answers {result: ok, email, role,
-- full_name, case, user_id}. Otherwise {result: not_found|canceled|used|expired|
-- internal_address|no_code|locked|code_expired|wrong_code[, attempts_left]|
-- needs_google|blocked}. A wrong or malformed code costs one of the 5 attempts.
CREATE OR REPLACE FUNCTION public.team_invitation_code_check(p_token text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_inv      public.team_invitations;
  v_row      public.team_invitation_codes;
  v_account  jsonb;
  v_attempts integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
    RETURN jsonb_build_object('result', 'internal_address');
  END IF;

  SELECT * INTO v_row FROM public.team_invitation_codes WHERE invitation_id = v_inv.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'no_code');
  END IF;
  IF v_row.attempts >= 5 THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;
  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'code_expired');
  END IF;

  IF coalesce(p_code, '') ~ '^[0-9]{6}$' AND public._team_code_hash(v_inv.id, p_code) = v_row.code_hash THEN
    v_account := public._team_code_account(v_inv.email);
    IF v_account->>'case' IN ('blocked', 'needs_google') THEN
      RETURN jsonb_build_object('result', v_account->>'case');
    END IF;
    DELETE FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
    RETURN jsonb_build_object(
      'result', 'ok',
      'email', v_inv.email,
      'role', v_inv.role,
      'full_name', coalesce(v_inv.full_name, ''),
      'case', v_account->>'case',
      'user_id', v_account->'user_id');
  END IF;

  UPDATE public.team_invitation_codes SET attempts = attempts + 1
   WHERE invitation_id = v_inv.id
  RETURNING attempts INTO v_attempts;
  IF v_attempts >= 5 THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;
  RETURN jsonb_build_object('result', 'wrong_code', 'attempts_left', 5 - v_attempts);
END;
$$;

-- Accepts the invitation for p_user once the Edge Function created the account or set its
-- password. Checks everything again. Answers {result: accepted, role} or {result:
-- not_found|no_account|canceled|used|expired|internal_address|wrong_account|blocked|needs_google}.
CREATE OR REPLACE FUNCTION public.accept_team_invitation_by_code(p_token text, p_user uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_role     public.user_role;
  v_active   boolean;
  v_inv      public.team_invitations;
  v_email    text;
  v_account  jsonb;
  v_new      public.user_role;
  v_sessions integer;
BEGIN
  IF p_user IS NULL OR p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  -- The person's row first, then the invitation: the order of every 00661 function, so an
  -- accept racing a removal waits instead of deadlocking.
  SELECT u.role, coalesce(u.is_active, true) INTO v_role, v_active
  FROM public.users u WHERE u.id = p_user
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'no_account');
  END IF;
  SELECT * INTO v_inv FROM public.team_invitations WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_inv.status = 'canceled' THEN
    RETURN jsonb_build_object('result', 'canceled');
  END IF;
  IF v_inv.status = 'accepted' THEN
    IF v_inv.accepted_user_id = p_user THEN
      RETURN jsonb_build_object('result', 'accepted', 'role', v_role);
    END IF;
    RETURN jsonb_build_object('result', 'used');
  END IF;
  IF v_inv.expires_at <= now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF v_inv.email ~ '@tricigo\.(app|system)$' THEN
    RETURN jsonb_build_object('result', 'internal_address');
  END IF;

  SELECT lower(btrim(coalesce(au.email, ''))) INTO v_email FROM auth.users au WHERE au.id = p_user;
  v_account := public._team_code_account(v_inv.email);
  IF v_email IS DISTINCT FROM v_inv.email OR (v_account->>'user_id') IS DISTINCT FROM p_user::text THEN
    RETURN jsonb_build_object('result', 'wrong_account');
  END IF;
  IF NOT v_active OR v_account->>'case' = 'blocked' THEN
    RETURN jsonb_build_object('result', 'blocked');
  END IF;
  IF v_account->>'case' NOT IN ('proven', 'password_only') THEN
    RETURN jsonb_build_object('result', 'needs_google');
  END IF;

  WITH s AS (DELETE FROM auth.sessions WHERE user_id = p_user RETURNING 1)
  SELECT count(*) INTO v_sessions FROM s;
  -- Refresh tokens with a session went with it (ON DELETE CASCADE); these are the rest.
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user::text;

  v_new := CASE WHEN public._team_role_rank(v_role::text) >= public._team_role_rank(v_inv.role::text)
                THEN v_role ELSE v_inv.role END;
  IF v_new IS DISTINCT FROM v_role THEN
    PERFORM public._team_write_role(p_user, v_new);
  END IF;
  -- What the code proved: the mailbox (password reset and e-mail login read email_verified_at,
  -- 00611) and a password the person chose (verify-otp must not overwrite it on a phone login).
  UPDATE public.users
     SET password_set_at = now(),
         email_verified_at = CASE WHEN email_verified_at IS NULL
                                   AND lower(btrim(coalesce(email, ''))) = v_inv.email
                                  THEN now() ELSE email_verified_at END
   WHERE id = p_user;
  UPDATE public.team_invitations
     SET status = 'accepted', accepted_at = now(), accepted_user_id = p_user
   WHERE id = v_inv.id;
  DELETE FROM public.team_invitation_codes WHERE invitation_id = v_inv.id;
  INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
  VALUES (v_inv.invited_by, 'team_invite_accepted', 'user', p_user::text,
          jsonb_build_object('role', v_role),
          jsonb_build_object('role', v_new, 'invitation_id', v_inv.id, 'method', 'email_code',
                             'account', v_account->>'case', 'sessions_closed', v_sessions));
  RETURN jsonb_build_object('result', 'accepted', 'role', v_new);
END;
$$;

-- 4. Permissions -----------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  public._team_code_hash(uuid, text),
  public._team_code_account(text),
  public.team_invitation_code_issue(text),
  public.team_invitation_code_check(text, text),
  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.team_invitation_code_issue(text),
  public.team_invitation_code_check(text, text),
  public.accept_team_invitation_by_code(text, uuid)
TO service_role;

-- 5. A copy pasted with CRLF line endings leaves carriage returns in the bodies --------
DO $crlf$
DECLARE
  v_fn  regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_code_hash(uuid, text)', 'public._team_code_account(text)',
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- 6. Self-checks -------------------------------------------------------------------------
DO $check$
DECLARE
  v_tbl  regclass;
  v_fn   regprocedure;
  v_role text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['public.team_invitation_codes', 'public.team_invitation_code_salt']::regclass[] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tbl) THEN
      RAISE EXCEPTION '00664: % has row level security disabled', v_tbl;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(v_role, v_tbl, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
        RAISE EXCEPTION '00664: % has privileges on %', v_role, v_tbl;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_tbl, 'SELECT') THEN
      RAISE EXCEPTION '00664: service_role cannot read %', v_tbl;
    END IF;
    IF has_table_privilege('service_role', v_tbl, 'TRUNCATE') THEN
      RAISE EXCEPTION '00664: service_role has TRUNCATE on %', v_tbl;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                 WHERE attrelid = 'public.users'::regclass AND attname = 'password_set_at' AND NOT attisdropped) THEN
    RAISE EXCEPTION '00664: public.users.password_set_at is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.team_invitation_code_salt WHERE id = 1 AND salt ~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION '00664: the code salt is missing';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public._team_code_hash(uuid, text)', 'public._team_code_account(text)',
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION '00664: % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '00664: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF position(chr(13) IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn)) > 0 THEN
      RAISE EXCEPTION '00664: % kept a carriage return', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.team_invitation_code_issue(text)', 'public.team_invitation_code_check(text, text)',
    'public.accept_team_invitation_by_code(text, uuid)']::regprocedure[]
  LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00664: service_role cannot execute %', v_fn;
    END IF;
  END LOOP;
END
$check$;
