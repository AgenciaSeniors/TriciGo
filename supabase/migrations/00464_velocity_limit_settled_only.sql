-- ============================================================
-- 00464_velocity_limit_settled_only.sql
--
-- Recharge velocity control UX fix + cap bump.
--
-- BEFORE: check_topup_velocity counted intents in
--   status IN ('completed','created','pending','processing')
-- toward the 24h recharge cap (default 3). So an ABANDONED checkout
-- (intent left 'pending' / 'created' because the user changed their mind,
-- had a bad signal, or the page failed) counted against the user — three
-- abandoned checkouts locked a paying customer out for 24h WITHOUT a single
-- charge. Verified in the field 2026-06-27 (a test user with 3 stale
-- 'pending' intents got "You have reached the recharge limit").
--
-- AFTER:
--   1. Count only SETTLED recharges — status IN ('completed','processing')
--      — toward both the 24h count cap AND the 30d spend cap. Abandoned
--      'pending'/'created' intents no longer count. A would-be abuser can
--      still only SETTLE N recharges per window (no money moves on a
--      'pending' intent), so the anti-fraud intent is preserved; only the
--      false-positive lockout from abandoned checkouts is removed.
--   2. Raise the 24h cap default 3 -> 5 (and set the live
--      platform_config value to 5), now that the count reflects real
--      settled recharges rather than abandoned attempts.
--
-- Signature unchanged -> CREATE OR REPLACE (no overload).
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_topup_velocity(p_user_id uuid, p_amount_usd numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_max_24h    integer;
  v_max_30d    numeric;
  v_count_24h  integer;
  v_sum_30d    numeric;
BEGIN
  SELECT (value::integer) INTO v_max_24h
  FROM platform_config WHERE key = 'velocity_max_recharges_24h';
  v_max_24h := COALESCE(v_max_24h, 5);   -- was 3; counts only settled recharges now

  SELECT (value::numeric) INTO v_max_30d
  FROM platform_config WHERE key = 'velocity_max_amount_usd_30d';
  v_max_30d := COALESCE(v_max_30d, 1000);

  -- 24h count cap — only SETTLED recharges count. Abandoned 'pending'/'created'
  -- intents must NOT lock a non-paying user out of the checkout.
  SELECT COUNT(*) INTO v_count_24h
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status IN ('completed', 'processing')
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '24 hours';

  IF v_count_24h >= v_max_24h THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'max_recharges_24h', 'limit', v_max_24h, 'current', v_count_24h);
  END IF;

  -- 30d spend cap — likewise only settled recharges count toward real spend.
  SELECT COALESCE(SUM(amount_usd), 0) INTO v_sum_30d
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status IN ('completed', 'processing')
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '30 days';

  IF v_sum_30d + COALESCE(p_amount_usd, 0) > v_max_30d THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'max_amount_30d', 'limit', v_max_30d, 'current', v_sum_30d);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$function$;

-- Set the live cap to 5 (the function still COALESCEs to 5 if this row is absent).
INSERT INTO platform_config (key, value)
VALUES ('velocity_max_recharges_24h', '5'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = '5'::jsonb;
