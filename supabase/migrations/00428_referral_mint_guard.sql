-- 00428_referral_mint_guard.sql
-- ============================================================================
-- INC-01 + INC-02 (P0, audit 2026-06-14): the referrals INSERT RLS only checks
-- referee_id=auth.uid(), so an authenticated user can POST directly to PostgREST
-- (bypassing the secure apply_referral_code RPC) a row with an attacker-chosen
-- bonus_amount (e.g. 999999999) and a self/accomplice referrer. The reward
-- triggers then compute the credit as cup_to_trc_centavos(v_ref.bonus_amount, …)
-- — i.e. they TRUST the row's amount — and MINT that much spendable TriciCoin to
-- the referrer, funded from platform_promotions. Reachable today (the referral
-- program is enabled).
--
-- Fix (closes the unbounded mint regardless of how the row was created):
--   1) The 3 reward functions (trg_referral_reward_on_complete,
--      trg_referral_reward_on_driver_approved, admin_reward_referral) now derive
--      the bonus from config (referral_bonus_cup) and IGNORE the row's
--      bonus_amount entirely — a crafted 999999999 pays the configured bonus.
--   2) A CHECK constraint blocks self-referral (referrer_id <> referee_id), and a
--      sanity cap bounds any stored bonus_amount. With UNIQUE(referee_id) already
--      present, the residual is normal referral abuse (one configured bonus per
--      referee, and only after the referee completes a real ride / driver
--      approval), not an unbounded mint.
--
-- In-place patches of the live function bodies (only the bonus computation line
-- changes); idempotent.
-- ============================================================================

-- 1) DB-level guards on the referrals row itself (prod is wiped → no violating data).
ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_no_self_referral CHECK (referrer_id <> referee_id);
ALTER TABLE public.referrals
  ADD CONSTRAINT referrals_bonus_sane CHECK (bonus_amount <= 100000);

-- 2) Reward functions: derive the bonus from config, never from the (user-writable) row.
DO $p$
DECLARE
  v_fns text[] := ARRAY[
    'public.trg_referral_reward_on_complete()',
    'public.trg_referral_reward_on_driver_approved()',
    'public.admin_reward_referral(uuid)'
  ];
  v_fn text;
  v_src text;
  v_target CONSTANT text := 'cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate)';
  v_repl   CONSTANT text := 'cup_to_trc_centavos(GREATEST(get_platform_config_numeric(''referral_bonus_cup'', 500), 0)::integer, v_exchange_rate)';
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    BEGIN
      SELECT pg_get_functiondef(v_fn::regprocedure) INTO v_src;
      IF v_src IS NOT NULL AND position(v_target IN v_src) > 0 THEN
        EXECUTE replace(v_src, v_target, v_repl);
        RAISE NOTICE 'referral reward %: bonus now config-derived (ignores row bonus_amount)', v_fn;
      ELSE
        RAISE NOTICE 'referral reward %: target not found (already patched?); skipping', v_fn;
      END IF;
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'referral reward % absent; skipping', v_fn;
    END;
  END LOOP;
END $p$;
