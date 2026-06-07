-- 00395_referral_bonus_configurable.sql
--
-- Make the referral bonus amount admin-configurable without a redeploy,
-- following the canonical platform_config pattern (get_platform_config_numeric).
--
-- Before: apply_referral_code() hardcoded a 500 CUP bonus on the referral row.
-- After:  it reads platform_config.referral_bonus_cup (default 500 if absent),
--         so an admin can change the bonus from the Platform Config screen.
--
-- The bonus is "locked in" on the referrals row at apply time (the reward
-- triggers read referrals.bonus_amount, not the live config). This is the
-- correct, fair behavior: a change only affects NEW referrals; pending ones
-- keep the amount that was promised when the code was applied.
--
-- The reward triggers (00394) are UNCHANGED. The referrals.bonus_amount column
-- default (500, from 00019) is left as-is — a harmless fallback; apply_referral_code
-- always sets the value explicitly.

-- 1. Seed the config key (idempotent). Stored as a JSON number, like the other
--    numeric platform_config keys (e.g. shared_ride_discount_per_seat_pct = 7).
INSERT INTO platform_config (key, value)
SELECT 'referral_bonus_cup', '500'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE key = 'referral_bonus_cup');

-- 2. apply_referral_code: read the bonus from config instead of a hardcoded 500.
--    Body reproduced verbatim from the live prod function (00319), with only the
--    bonus source changed.
CREATE OR REPLACE FUNCTION public.apply_referral_code(p_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_referee_id UUID := auth.uid();
  v_referrer_id UUID;
  v_referrer_active BOOLEAN;
  v_normalized_code TEXT;
  v_referral_id UUID;
  v_bonus_cup INTEGER;
BEGIN
  IF v_referee_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  v_normalized_code := upper(trim(p_code));

  SELECT rc.user_id, u.is_active
    INTO v_referrer_id, v_referrer_active
  FROM referral_codes rc
  JOIN users u ON u.id = rc.user_id
  WHERE rc.code = v_normalized_code;

  IF v_referrer_id IS NULL THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  IF NOT COALESCE(v_referrer_active, false) THEN
    RAISE EXCEPTION 'Codigo de referido invalido' USING ERRCODE = 'P0001';
  END IF;

  IF v_referrer_id = v_referee_id THEN
    RAISE EXCEPTION 'No puedes usar tu propio codigo' USING ERRCODE = 'P0002';
  END IF;

  -- 00395: admin-configurable bonus (defaults to 500 CUP if the key is absent).
  v_bonus_cup := GREATEST(COALESCE(get_platform_config_numeric('referral_bonus_cup', 500), 500)::INTEGER, 0);

  BEGIN
    INSERT INTO referrals (referrer_id, referee_id, code, status, bonus_amount)
    VALUES (v_referrer_id, v_referee_id, v_normalized_code, 'pending', v_bonus_cup)
    RETURNING id INTO v_referral_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ya usaste un codigo de referido' USING ERRCODE = 'P0003';
  END;

  RETURN v_referral_id;
END;
$function$;
