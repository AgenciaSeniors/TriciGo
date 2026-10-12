-- ============================================================
-- 00658: once-per-person rewards are tied to the confirmed phone, not the account
-- ============================================================
-- A promo code was once per ACCOUNT (promotion_uses, unique per user) and a
-- referral paid once per ACCOUNT (referrals.referee_id, unique). Deleting the
-- account moves both rows to the anonymous user …0099 (00657), so the same
-- person could sign up again with the same phone and use BIENVENIDA again, or
-- be referred again and pay the referrer another bonus.
--
-- Now a reward is claimed by the confirmed phone of the account
-- (auth.users.phone with phone_confirmed_at), stored as a salted hash in
-- reward_claims. Those rows have no foreign key to users and survive the
-- deletion of the account on purpose.
--   * Promo codes: each one once per phone. validate_promo_code answers
--     'phone_required' to an account without a confirmed phone and
--     'already_used' to a phone that already used it; the ride trigger drops
--     the promo in both cases, like a second use. Canceling the ride gives
--     the claim back, like it gives back the use.
--   * Referrals: a phone is paid for as a referee once. apply_referral_code
--     refuses an account without a confirmed phone (P0004) and a phone that
--     was already paid for (P0003). The two live reward triggers (and the
--     unattached driver-approved one) pay nothing for such a referee; the
--     referral stays pending. admin_reward_referral refuses a phone that was
--     already paid for.
--   * The referrals already paid (19 in prod on 2026-10-12) are claimed by
--     their referee's phone here. promotion_uses is empty in prod; it is
--     claimed the same way.
-- Owner decision (2026-10-12): without a confirmed phone there are no
-- once-per-person rewards. The apps already make every user confirm a phone.
--
-- The phone is hashed with a random salt kept in reward_identity_salt (a
-- lock table, like nearby_vehicle_salt in 00645). Anyone who can read the
-- salt can recover a phone by trying every number: the salt keeps the hashes
-- useless to whoever only has a copy of reward_claims.
--
-- The live functions are patched in place from their live bodies, and only
-- if each body is the one read from prod on 2026-10-12.
-- Rehearsal: supabase/tests/00658/run.sh.
-- ============================================================

-- ── salt and claims (lock tables: no policies, service_role only) ───────
CREATE TABLE IF NOT EXISTS public.reward_identity_salt (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  salt text NOT NULL
);
ALTER TABLE public.reward_identity_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_identity_salt FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_identity_salt TO service_role;
INSERT INTO public.reward_identity_salt (id, salt)
VALUES (1, md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text))
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.reward_claims (
  identity_hash text NOT NULL,
  claim text NOT NULL,
  user_id uuid NOT NULL,
  ride_id uuid,
  referral_id uuid,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  PRIMARY KEY (identity_hash, claim)
);
CREATE INDEX IF NOT EXISTS reward_claims_ride_idx ON public.reward_claims (ride_id) WHERE ride_id IS NOT NULL;
ALTER TABLE public.reward_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_claims FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_claims TO service_role;

COMMENT ON TABLE public.reward_claims IS
  '00658: once-per-person rewards by confirmed phone (salted hash). claim is '
  '''promo:<promotion id>'' or ''referral_referee''. A row with released_at was given '
  'back (the promo ride was canceled) and can be claimed again. No foreign key to '
  'users: the claim outlives a deleted account on purpose.';

-- ── helpers (SECURITY DEFINER, service_role only) ───────────────────────
CREATE OR REPLACE FUNCTION public._reward_identity_hash(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_digits text;
  v_salt text;
BEGIN
  SELECT regexp_replace(u.phone, '\D', '', 'g') INTO v_digits
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.phone_confirmed_at IS NOT NULL;
  IF v_digits IS NULL OR v_digits = '' THEN
    RETURN NULL;
  END IF;

  SELECT s.salt INTO v_salt FROM public.reward_identity_salt s WHERE s.id = 1;
  IF v_salt IS NULL OR v_salt = '' THEN
    RETURN NULL;
  END IF;

  RETURN encode(sha256(convert_to(v_salt || ':' || v_digits, 'UTF8')), 'hex');
END;
$$;

-- 'no_phone', 'taken' or 'free'. Reads only.
CREATE OR REPLACE FUNCTION public._reward_claim_status(p_user_id uuid, p_claim text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reward_claims c
              WHERE c.identity_hash = v_hash AND c.claim = p_claim AND c.released_at IS NULL) THEN
    RETURN 'taken';
  END IF;
  RETURN 'free';
END;
$$;

-- 'claimed', 'no_phone' or 'taken'. A claim that was given back is taken again.
-- Two claims of the same phone at once: the second waits for the first and
-- gets 'taken' if it committed.
CREATE OR REPLACE FUNCTION public._claim_reward(p_user_id uuid, p_claim text, p_ride_id uuid DEFAULT NULL, p_referral_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_hash text := public._reward_identity_hash(p_user_id);
  v_ok boolean;
BEGIN
  IF v_hash IS NULL THEN
    RETURN 'no_phone';
  END IF;

  INSERT INTO public.reward_claims (identity_hash, claim, user_id, ride_id, referral_id)
  VALUES (v_hash, p_claim, p_user_id, p_ride_id, p_referral_id)
  ON CONFLICT (identity_hash, claim) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         ride_id = EXCLUDED.ride_id,
         referral_id = EXCLUDED.referral_id,
         claimed_at = now(),
         released_at = NULL
   WHERE public.reward_claims.released_at IS NOT NULL
  RETURNING true INTO v_ok;

  RETURN CASE WHEN v_ok THEN 'claimed' ELSE 'taken' END;
END;
$$;

REVOKE ALL ON FUNCTION public._reward_identity_hash(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reward_claim_status(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._claim_reward(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reward_identity_hash(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._reward_claim_status(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public._claim_reward(uuid, text, uuid, uuid) TO service_role;

-- ── patch helper: anchors replaced exactly once, on the known live body ──
-- p_pairs = {anchor1, replacement1, anchor2, replacement2, ...}. Skips a body
-- that already carries '00658:'.
CREATE OR REPLACE FUNCTION pg_temp.patch_00658(p_proc regprocedure, p_md5 text, p_pairs text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_def text := replace(pg_get_functiondef(p_proc), chr(13), '');
  v_old text;
  v_new text;
  i int;
BEGIN
  IF position('00658:' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = p_proc) <> p_md5 THEN
    RAISE EXCEPTION '00658: % is not the body read from prod; re-read it before patching', p_proc;
  END IF;
  FOR i IN 1 .. array_length(p_pairs, 1) / 2 LOOP
    v_old := replace(p_pairs[2 * i - 1], chr(13), '');
    v_new := replace(p_pairs[2 * i], chr(13), '');
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '00658: anchor % not found exactly once in %', i, p_proc;
    END IF;
    v_def := replace(v_def, v_old, v_new);
  END LOOP;
  EXECUTE v_def;
END;
$$;

-- ── rides: a promo is claimed by the phone ──────────────────────────────
SELECT pg_temp.patch_00658('public.tg_rides_validate_promo_discount()'::regprocedure,
  'b70dc359fccf82f5d5b3209ca03e9816', ARRAY[
$a1$  IF TG_OP = 'INSERT' THEN
    BEGIN
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)$a1$,
$r1$  IF TG_OP = 'INSERT' THEN
    BEGIN
      -- 00658: each promo once per confirmed phone, not per account. No
      -- confirmed phone, or a phone that already used it (also from an
      -- account deleted since), drops the promo like a second use does.
      IF public._claim_reward(NEW.customer_id, 'promo:' || v_promo.id::text, NEW.id) <> 'claimed' THEN
        RAISE unique_violation;
      END IF;
      INSERT INTO promotion_uses (promotion_id, user_id, ride_id)$r1$,
$a2$    IF NOT COALESCE(v_slot_claimed, false) THEN
$a2$,
$r2$    IF NOT COALESCE(v_slot_claimed, false) THEN
      UPDATE public.reward_claims SET released_at = now()
       WHERE claim = 'promo:' || v_promo.id::text AND ride_id = NEW.id AND released_at IS NULL;
$r2$]);

-- ── rides: canceling gives the phone's claim back with the use ──────────
SELECT pg_temp.patch_00658('public.tg_rides_rollback_promo_on_cancel()'::regprocedure,
  '02515bc12de7afbc36f60e709daa18ba', ARRAY[
$a1$  IF COALESCE(v_use_existed, false) THEN
$a1$,
$r1$  -- 00658: the phone's claim on this promo goes back too.
  UPDATE public.reward_claims SET released_at = now()
   WHERE claim = 'promo:' || NEW.promo_code_id::text AND ride_id = NEW.id AND released_at IS NULL;

  IF COALESCE(v_use_existed, false) THEN
$r1$]);

-- ── validate_promo_code: the apps learn it before asking for the ride ───
SELECT pg_temp.patch_00658('public.validate_promo_code(text, uuid, integer)'::regprocedure,
  'ed42f3a7a8be2e7367f38f0da2f5ca79', ARRAY[
$a1$  v_already_used BOOLEAN := false;
$a1$,
$r1$  v_already_used BOOLEAN := false;
  v_claim TEXT;
$r1$,
$a2$  IF v_already_used THEN
    RETURN jsonb_build_object('valid', false, 'error', 'already_used');
  END IF;
$a2$,
$r2$  IF v_already_used THEN
    RETURN jsonb_build_object('valid', false, 'error', 'already_used');
  END IF;

  -- 00658: once per confirmed phone, from any account.
  v_claim := public._reward_claim_status(p_user_id, 'promo:' || v_promo.id::text);
  IF v_claim = 'no_phone' THEN
    RETURN jsonb_build_object('valid', false, 'error', 'phone_required');
  END IF;
  IF v_claim = 'taken' THEN
    RETURN jsonb_build_object('valid', false, 'error', 'already_used');
  END IF;
$r2$]);

-- ── apply_referral_code: a phone is referred once ───────────────────────
SELECT pg_temp.patch_00658('public.apply_referral_code(text)'::regprocedure,
  '5090797ad15e4ac76b82961849f241e5', ARRAY[
$a1$  v_bonus_cup INTEGER;
$a1$,
$r1$  v_bonus_cup INTEGER;
  v_claim TEXT;
$r1$,
$a2$  IF v_referrer_id = v_referee_id THEN
    RAISE EXCEPTION 'No puedes usar tu propio codigo' USING ERRCODE = 'P0002';
  END IF;
$a2$,
$r2$  IF v_referrer_id = v_referee_id THEN
    RAISE EXCEPTION 'No puedes usar tu propio codigo' USING ERRCODE = 'P0002';
  END IF;

  -- 00658: one referral reward per confirmed phone, from any account.
  v_claim := public._reward_claim_status(v_referee_id, 'referral_referee');
  IF v_claim = 'no_phone' THEN
    RAISE EXCEPTION 'Confirma tu teléfono para usar un código de referido.' USING ERRCODE = 'P0004';
  END IF;
  IF v_claim = 'taken' THEN
    RAISE EXCEPTION 'Ya usaste un codigo de referido' USING ERRCODE = 'P0003';
  END IF;
$r2$]);

-- ── reward triggers: pay once per referee phone ─────────────────────────
-- Inside the money block: a later failure gives the claim back with the money.
SELECT pg_temp.patch_00658(e.proc, e.md5, ARRAY[
$a1$    v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, _gift_wallet_type(v_ref.referrer_id));
$a1$,
$r1$    -- 00658: one referral reward per confirmed phone. No confirmed phone, or
    -- a phone already paid for (also from an account deleted since): nothing
    -- is paid and the referral stays pending.
    IF public._claim_reward(v_ref.referee_id, 'referral_referee', NULL, v_ref.id) <> 'claimed' THEN
      RETURN NEW;
    END IF;
    v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, _gift_wallet_type(v_ref.referrer_id));
$r1$])
FROM (VALUES
  ('public.trg_referral_reward_on_complete()'::regprocedure, '2f0a51cac7603e1c7bda7228e06e97f6'),
  ('public.trg_referral_reward_on_driver_first_ride()'::regprocedure, '66be7c5cfe89ea9f2df27f405b6147b7'),
  ('public.trg_referral_reward_on_driver_approved()'::regprocedure, '18ba26bd32bd10f5f9ce43aab8cb9849')
) AS e(proc, md5);

-- ── admin_reward_referral: refuses a phone already paid for ─────────────
SELECT pg_temp.patch_00658('public.admin_reward_referral(uuid)'::regprocedure,
  '1e241e471b6225c45c592a45f251e5a2', ARRAY[
$a1$  v_welcome_txn_id UUID;
$a1$,
$r1$  v_welcome_txn_id UUID;
  v_claim TEXT;
$r1$,
$a2$  v_exchange_rate := get_current_exchange_rate();
$a2$,
$r2$  -- 00658: one referral reward per confirmed phone. A referee without one
  -- can still be paid by an admin; a phone already paid for cannot.
  v_claim := public._claim_reward(v_ref.referee_id, 'referral_referee', NULL, v_ref.id);
  IF v_claim = 'taken' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'El teléfono de esta persona ya cobró un bono por referido.',
      DETAIL = 'referral_phone_already_rewarded';
  END IF;

  v_exchange_rate := get_current_exchange_rate();
$r2$]);

-- ── backfill: rewards already paid or in use are claimed by their phone ─
INSERT INTO public.reward_claims (identity_hash, claim, user_id, referral_id, claimed_at)
SELECT x.h, 'referral_referee', r.referee_id, r.id, COALESCE(r.rewarded_at, r.created_at)
  FROM public.referrals r
 CROSS JOIN LATERAL (SELECT public._reward_identity_hash(r.referee_id) AS h) x
 WHERE r.status = 'rewarded' AND x.h IS NOT NULL
 ORDER BY COALESCE(r.rewarded_at, r.created_at)
ON CONFLICT (identity_hash, claim) DO NOTHING;

INSERT INTO public.reward_claims (identity_hash, claim, user_id, ride_id, claimed_at)
SELECT x.h, 'promo:' || pu.promotion_id::text, pu.user_id, pu.ride_id, pu.created_at
  FROM public.promotion_uses pu
 CROSS JOIN LATERAL (SELECT public._reward_identity_hash(pu.user_id) AS h) x
 WHERE x.h IS NOT NULL
 ORDER BY pu.created_at
ON CONFLICT (identity_hash, claim) DO NOTHING;

-- ── pasted from Windows: the new bodies lose their \r ────────────────────
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public._reward_identity_hash(uuid)'::regprocedure,
                              'public._reward_claim_status(uuid, text)'::regprocedure,
                              'public._claim_reward(uuid, text, uuid, uuid)'::regprocedure] LOOP
    v_def := pg_get_functiondef(v_fn);
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── verification ─────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(e.fn, ', ') INTO v_bad
    FROM (VALUES
      ('_reward_identity_hash(uuid)', '4f1942d94b70a77d6b5007d776f5b425'),
      ('_reward_claim_status(uuid, text)', '73d57eecb3631f0db8d1bc9d7a71fb30'),
      ('_claim_reward(uuid, text, uuid, uuid)', 'd9a8726c2f105908c0df7fe8c59b2982'),
      ('tg_rides_validate_promo_discount()', 'cad4cf62d95e5055950b67564c6da7f4'),
      ('tg_rides_rollback_promo_on_cancel()', '0fd8994f3d1dd121e5168ff58ab0fdbc'),
      ('validate_promo_code(text, uuid, integer)', '952805817a1ea73ab0fbb93f28884a30'),
      ('apply_referral_code(text)', '51e1c19964c02c7a5b054d8f3b222f16'),
      ('trg_referral_reward_on_complete()', '20d16698a937f65b06fb304f8741be8b'),
      ('trg_referral_reward_on_driver_first_ride()', 'd26ecb59805e46327b893a17f5c488a8'),
      ('trg_referral_reward_on_driver_approved()', '3bc3a0dae8246b17284d19908a615acb'),
      ('admin_reward_referral(uuid)', '0d9b9f8b7fb753465290e281091a03da')
    ) AS e(fn, md5)
   WHERE (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
           WHERE p.oid = ('public.' || e.fn)::regprocedure) IS DISTINCT FROM e.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00658: unexpected bodies after the patch: %', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.reward_identity_salt WHERE id = 1 AND length(salt) = 64) THEN
    RAISE EXCEPTION '00658: reward_identity_salt has no salt';
  END IF;

  IF has_table_privilege('anon', 'public.reward_identity_salt', 'SELECT')
     OR has_table_privilege('authenticated', 'public.reward_identity_salt', 'SELECT')
     OR has_table_privilege('anon', 'public.reward_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.reward_claims', 'SELECT') THEN
    RAISE EXCEPTION '00658: clients can read the reward salt or claims';
  END IF;

  SELECT string_agg(f, ', ') INTO v_bad
    FROM unnest(ARRAY['public._reward_identity_hash(uuid)', 'public._reward_claim_status(uuid, text)',
                      'public._claim_reward(uuid, text, uuid, uuid)']) AS f
   WHERE has_function_privilege('anon', f, 'EXECUTE')
      OR has_function_privilege('authenticated', f, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00658: clients can execute %', v_bad;
  END IF;

  -- Every paid referral whose referee still has a confirmed phone is claimed.
  SELECT string_agg(r.id::text, ', ') INTO v_bad
    FROM public.referrals r
   WHERE r.status = 'rewarded'
     AND public._reward_identity_hash(r.referee_id) IS NOT NULL
     AND public._reward_claim_status(r.referee_id, 'referral_referee') <> 'taken';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00658: paid referrals without a claim: %', v_bad;
  END IF;
END
$verify$;
