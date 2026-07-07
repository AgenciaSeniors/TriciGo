-- 00492: Re-emit the placeholder referral codes seeded by 00491.
--
-- 00491 backfilled referral_codes with code = upper(left(user_id,8)) so codes
-- already shared (which matched the client placeholder) stayed redeemable. Side
-- effect: those codes are the uppercase 8-hex prefix of the user's UUID —
-- guessable/enumerable (2^32 space) and inconsistent with the 10-hex random
-- format get_or_create_referral_code() now mints for new users.
--
-- This re-rolls every remaining placeholder row to a fresh random 10-hex code
-- (same generator as the RPC). Idempotent: after running, no row equals its
-- UUID prefix, so re-running is a no-op. gen_random_bytes is schema-qualified
-- (extensions.*) so it resolves regardless of the session search_path.
DO $$
DECLARE
  r RECORD;
  v_code TEXT;
  v_try INTEGER;
BEGIN
  FOR r IN
    SELECT user_id FROM public.referral_codes
    WHERE code = upper(left(user_id::text, 8))
  LOOP
    v_try := 0;
    LOOP
      v_try := v_try + 1;
      v_code := upper(encode(extensions.gen_random_bytes(5), 'hex'));
      BEGIN
        UPDATE public.referral_codes SET code = v_code WHERE user_id = r.user_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        IF v_try > 5 THEN
          RAISE EXCEPTION 'could not generate a unique referral code for % after % attempts', r.user_id, v_try;
        END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
