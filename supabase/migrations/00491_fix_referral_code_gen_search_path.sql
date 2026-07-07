-- 00491: Fix referral code generation (search_path) + backfill existing users.
--
-- BUG (verified in prod 2026-07-07): the referral feature never worked once.
-- `referral_codes` had 0 rows for all users and `referrals` had 0 redemptions.
--
-- Root cause: get_or_create_referral_code() calls gen_random_bytes(5) from the
-- pgcrypto extension, which lives in the `extensions` schema. The function was
-- created with `SET search_path = public, pg_catalog` (no `extensions`), so
-- every call failed with:
--   ERROR 42883: function gen_random_bytes(integer) does not exist
-- => the code row was never inserted. The mobile/web client then fell back to a
-- placeholder code (upper(left(user_id, 8))) that was never persisted, so when a
-- friend entered it, apply_referral_code found no matching row and raised P0001
-- ("Código de referido inválido").
--
-- Fix: add `extensions` to the function's search_path so gen_random_bytes
-- resolves (canonical pattern used elsewhere in this repo).

ALTER FUNCTION public.get_or_create_referral_code()
  SET search_path = public, extensions, pg_catalog;

-- Backfill existing users so codes already shared as the client placeholder
-- (upper(left(user_id, 8)) === userId.substring(0,8).toUpperCase()) become
-- redeemable. Idempotent: skips users that already have a code, and skips on
-- the rare event of a code collision (those users get a fresh random code
-- on-demand via the now-fixed get-or-create RPC).
INSERT INTO public.referral_codes (user_id, code)
SELECT u.id, upper(left(u.id::text, 8))
FROM public.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.referral_codes rc WHERE rc.user_id = u.id
)
ON CONFLICT (code) DO NOTHING;
