-- ============================================================
-- 00604: the two seeded system accounts can no longer sign in
--
-- 00007 seeded auth.users 00000000-0000-0000-0000-000000000001
-- (platform@tricigo.system, public.users role super_admin) with the password
-- crypt('not-a-real-password', ...), and 00287 seeded ...0099
-- (anonymized@tricigo.internal) with 'not-a-real-password-disabled-account'.
-- Both have a confirmed email, aud 'authenticated' and no ban. The repository
-- is public and email/password sign-in is enabled, so anyone who read those
-- migrations could sign in to production as super_admin.
--
-- Verified on 2026-09-27 (read-only): both published passwords still matched
-- in production. Neither account had ever signed in (last_sign_in_at NULL,
-- 0 sessions, 0 live refresh tokens).
--
-- Fix: a random password nobody knows and a ban until 2999 for both, plus any
-- session they might hold in other environments. They are not deleted:
-- ...0001 owns the platform wallets (platform_revenue, platform_promotions,
-- platform_fx_reserve, looked up by that user_id), and ...0099 owns the rows
-- anonymize_user_references re-points. Nothing signs in as either. Their
-- public.users rows, roles and wallets are left as they are.
--
-- The migration asserts that neither published password works any more and
-- that both accounts are banned. It is idempotent: a re-run draws another
-- random password and keeps the ban. A database without these accounts is a
-- no-op.
--
-- Applied to production on 2026-09-27, before this PR was merged, as an
-- emergency authorized by the owner.
-- ============================================================

UPDATE auth.users
SET encrypted_password = extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf')),
    banned_until       = '2999-12-31 00:00:00+00'
WHERE id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099');

DELETE FROM auth.sessions
WHERE user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099');

-- Self-test ----------------------------------------------------------------------
DO $selftest$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth.users
    WHERE id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099')
      AND (encrypted_password = extensions.crypt('not-a-real-password', encrypted_password)
           OR encrypted_password = extensions.crypt('not-a-real-password-disabled-account', encrypted_password)
           OR banned_until IS NULL
           OR banned_until < '2999-01-01 00:00:00+00')
  ) THEN
    RAISE EXCEPTION '00604 self-test: a seeded system account still takes a published password or is not banned';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.sessions
             WHERE user_id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099')) THEN
    RAISE EXCEPTION '00604 self-test: a seeded system account still has a session';
  END IF;
END
$selftest$;
