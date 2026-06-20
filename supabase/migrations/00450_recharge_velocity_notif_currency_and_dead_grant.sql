-- 00450_recharge_velocity_notif_currency_and_dead_grant.sql
-- Pre-launch audit 2026-06-20 — AUD-009 (P2) + AUD-019 (P3) + AUD-021 (P3). All backend, no money movement.
--
-- AUD-009: check_topup_velocity counted only status='completed', so N concurrent recharge intents
-- each read 0 in-flight and all passed before any settled (the velocity limit was advisory). Count
-- in-flight states too. Corporate stays exempt.
--
-- AUD-019: notify_payment_intent_failure rendered the amount in USD while send_payment_failed_email
-- (00402) renders CUP — the two channels disagreed for the same failed-payment event. Render CUP in
-- the push too (CUP-first, like the email), for Cuban users.
--
-- AUD-021: get_users_with_anniversary_today was whitelisted for the behavioral-emails EF (00348) but
-- the EF never wired an anniversary path (0 DB callers, no EF reference) — dead infra. Drop it.

-- ── AUD-009: include in-flight recharge intents in both velocity windows. ──
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
  v_max_24h := COALESCE(v_max_24h, 3);

  SELECT (value::numeric) INTO v_max_30d
  FROM platform_config WHERE key = 'velocity_max_amount_usd_30d';
  v_max_30d := COALESCE(v_max_30d, 1000);

  -- AUD-009: count completed AND in-flight intents so parallel creates can't bypass the limit.
  SELECT COUNT(*) INTO v_count_24h
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status IN ('completed', 'created', 'pending', 'processing')
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '24 hours';

  IF v_count_24h >= v_max_24h THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'max_recharges_24h', 'limit', v_max_24h, 'current', v_count_24h);
  END IF;

  SELECT COALESCE(SUM(amount_usd), 0) INTO v_sum_30d
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status IN ('completed', 'created', 'pending', 'processing')
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '30 days';

  IF v_sum_30d + COALESCE(p_amount_usd, 0) > v_max_30d THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'max_amount_30d', 'limit', v_max_30d, 'current', v_sum_30d);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$function$;

-- ── AUD-019: payment-failed push renders CUP (matching the email). ──
CREATE OR REPLACE FUNCTION public.notify_payment_intent_failure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_title       TEXT;
  v_body        TEXT;
  v_amount_cup  INTEGER;
  v_service_key TEXT;
  v_headers     JSONB;
BEGIN
  IF NEW.status <> 'failed' OR OLD.status = 'failed' THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- AUD-019: CUP-first (like send_payment_failed_email, 00402); convert USD at the current rate.
  v_amount_cup := COALESCE(NEW.amount_cup, ROUND(NEW.amount_usd * get_current_exchange_rate())::integer);

  v_title := 'Pago no completado';
  v_body  := 'Tu recarga de ' ||
             CASE WHEN v_amount_cup IS NOT NULL THEN to_char(v_amount_cup, 'FM999G999G990') || ' CUP ' ELSE '' END ||
             'no pudo procesarse. Intentalo nuevamente.';

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := jsonb_build_object(
      'user_id', NEW.user_id::text,
      'title',   v_title,
      'body',    v_body,
      'category', 'payment',
      'data', jsonb_build_object(
        'type',              'payment',
        'payment_intent_id', NEW.id::text,
        'status',            'failed'
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

-- ── AUD-021: drop the dead anniversary function (0 callers, EF never wired it). ──
DO $drop$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig FROM pg_proc
    WHERE proname = 'get_users_with_anniversary_today' AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig::text;
    RAISE NOTICE 'dropped dead function %', r.sig;
  END LOOP;
END $drop$;
