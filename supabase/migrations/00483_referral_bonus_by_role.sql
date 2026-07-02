-- 00483: role-specific referral bonus — pay MORE for bringing a DRIVER.
--
-- IG-plan readiness review 2026-07-02: Pub 8 promises 2,000 CUP for
-- referring a driver while Pub 12 promises 500 CUP for referring a rider.
-- Today the three live payers (trg_referral_reward_on_complete,
-- trg_referral_reward_on_driver_approved, admin_reward_referral) all read
-- the SAME platform_config.referral_bonus_cup — distinct amounts per role
-- are not expressible (confirmed adversarially against the live bodies).
--
-- New keys (fallback semantics: driver-specific applies when > 0, else the
-- base key — so leaving them at 0 keeps today's behavior):
--   referral_bonus_driver_cup          seeded at 2000 (per the campaign)
--   referral_welcome_bonus_driver_cup  seeded at 0 (mirror of 00477's key)
--
-- In-place patches (canonical pattern — the current bodies are the 00477
-- versions; anchors verified unique below):
--   * driver trigger: bonus + welcome reads become driver-aware CASEs, and
--     referrals.bonus_amount is updated at pay time so the history shows
--     the amount actually paid (apply_referral_code stamps the base amount
--     at APPLY time, when the referee's final role is unknown).
--   * admin_reward_referral: same, but role-detected via the referee having
--     an APPROVED driver profile.
--
-- The rider trigger (on_complete) intentionally keeps the base key. Known
-- design race (documented, accepted): a referee who completes a ride as a
-- PASSENGER before being approved as a driver consumes the referral at the
-- base amount — first trigger wins.

-- 1. Seed keys (idempotent).
INSERT INTO platform_config (key, value)
SELECT 'referral_bonus_driver_cup', '2000'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE key = 'referral_bonus_driver_cup');

INSERT INTO platform_config (key, value)
SELECT 'referral_welcome_bonus_driver_cup', '0'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE key = 'referral_welcome_bonus_driver_cup');

-- 2. Driver-approval trigger.
DO $patch$
DECLARE
  v_src TEXT;
  v_bonus_lit TEXT := $lit$get_platform_config_numeric('referral_bonus_cup', 500)$lit$;
  v_welcome_lit TEXT := $lit$get_platform_config_numeric('referral_welcome_bonus_cup', 0)$lit$;
  v_status_lit TEXT := $lit$SET status = 'rewarded',$lit$;
  v_count INTEGER;
BEGIN
  BEGIN
    SELECT pg_get_functiondef('public.trg_referral_reward_on_driver_approved()'::regprocedure)
    INTO v_src;
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '00483: driver trigger absent; skipping';
    RETURN;
  END;

  IF position('referral_bonus_driver_cup' IN v_src) > 0 THEN
    RAISE NOTICE '00483: driver trigger already patched; skipping';
    RETURN;
  END IF;

  v_count := (length(v_src) - length(replace(v_src, v_bonus_lit, ''))) / length(v_bonus_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: bonus literal occurs % times in driver trigger (expected 1)', v_count;
  END IF;
  v_count := (length(v_src) - length(replace(v_src, v_welcome_lit, ''))) / length(v_welcome_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: welcome literal occurs % times in driver trigger (expected 1)', v_count;
  END IF;
  v_count := (length(v_src) - length(replace(v_src, v_status_lit, ''))) / length(v_status_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: status literal occurs % times in driver trigger (expected 1)', v_count;
  END IF;

  v_src := replace(v_src, v_bonus_lit,
    $r$(CASE WHEN get_platform_config_numeric('referral_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_bonus_cup', 500) END)$r$);
  v_src := replace(v_src, v_welcome_lit,
    $r$(CASE WHEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_welcome_bonus_cup', 0) END)$r$);
  v_src := replace(v_src, v_status_lit,
    $r$SET status = 'rewarded',
        bonus_amount = v_bonus_trc,$r$);

  EXECUTE v_src;
  RAISE NOTICE '00483: driver trigger patched (role-specific bonus + history amount)';
END $patch$;

-- 3. admin_reward_referral (role-aware via approved driver profile).
DO $patch$
DECLARE
  v_src TEXT;
  v_bonus_lit TEXT := $lit$get_platform_config_numeric('referral_bonus_cup', 500)$lit$;
  v_welcome_lit TEXT := $lit$get_platform_config_numeric('referral_welcome_bonus_cup', 0)$lit$;
  v_status_lit TEXT := $lit$SET status = 'rewarded', rewarded_at$lit$;
  v_count INTEGER;
BEGIN
  BEGIN
    SELECT pg_get_functiondef('public.admin_reward_referral(uuid)'::regprocedure)
    INTO v_src;
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE '00483: admin_reward_referral absent; skipping';
    RETURN;
  END;

  IF position('referral_bonus_driver_cup' IN v_src) > 0 THEN
    RAISE NOTICE '00483: admin_reward_referral already patched; skipping';
    RETURN;
  END IF;

  v_count := (length(v_src) - length(replace(v_src, v_bonus_lit, ''))) / length(v_bonus_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: bonus literal occurs % times in admin fn (expected 1)', v_count;
  END IF;
  v_count := (length(v_src) - length(replace(v_src, v_welcome_lit, ''))) / length(v_welcome_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: welcome literal occurs % times in admin fn (expected 1)', v_count;
  END IF;
  v_count := (length(v_src) - length(replace(v_src, v_status_lit, ''))) / length(v_status_lit);
  IF v_count <> 1 THEN
    RAISE EXCEPTION '00483: status literal occurs % times in admin fn (expected 1)', v_count;
  END IF;

  v_src := replace(v_src, v_bonus_lit,
    $r$(CASE WHEN get_platform_config_numeric('referral_bonus_driver_cup', 0) > 0 AND EXISTS (SELECT 1 FROM driver_profiles WHERE user_id = v_ref.referee_id AND status = 'approved') THEN get_platform_config_numeric('referral_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_bonus_cup', 500) END)$r$);
  v_src := replace(v_src, v_welcome_lit,
    $r$(CASE WHEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) > 0 AND EXISTS (SELECT 1 FROM driver_profiles WHERE user_id = v_ref.referee_id AND status = 'approved') THEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_welcome_bonus_cup', 0) END)$r$);
  v_src := replace(v_src, v_status_lit,
    $r$SET status = 'rewarded', bonus_amount = v_bonus_trc, rewarded_at$r$);

  EXECUTE v_src;
  RAISE NOTICE '00483: admin_reward_referral patched (role-aware bonus + history amount)';
END $patch$;
