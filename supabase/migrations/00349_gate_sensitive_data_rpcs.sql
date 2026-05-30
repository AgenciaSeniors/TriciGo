-- ============================================================
-- Migration 00349: add in-body authorization to sensitive data RPCs
--
-- Companion to 00348. Revoking `anon` stops UNauthenticated reads, but
-- these four SECURITY DEFINER functions still had no check that the
-- *authenticated* caller is allowed to see the data — any logged-in user
-- could read another user's wallet, or pull admin-only platform totals.
-- We add the missing guard inside each function body (the function keeps
-- its existing SECURITY DEFINER + search_path; only a guard is prepended).
--
--   - get_admin_dashboard_metrics / get_admin_wallet_stats → admin only.
--   - get_wallet_summary / get_driver_quota_status → the owner (or admin).
--
-- Bodies are reproduced verbatim from the live definitions with only the
-- guard added, so behaviour is otherwise unchanged.
-- ============================================================

-- Admin-only platform metrics.
CREATE OR REPLACE FUNCTION public.get_admin_dashboard_metrics()
 RETURNS TABLE(active_rides bigint, total_rides_today bigint, online_drivers bigint, total_revenue_today bigint, pending_verifications bigint, open_incidents bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM rides
     WHERE status IN ('searching','accepted','driver_en_route','arrived_at_pickup','in_progress'))
      AS active_rides,
    (SELECT COUNT(*) FROM rides
     WHERE created_at >= CURRENT_DATE)
      AS total_rides_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE is_online = true)
      AS online_drivers,
    (SELECT COALESCE(SUM(final_fare_cup), 0) FROM rides
     WHERE status = 'completed' AND completed_at >= CURRENT_DATE)
      AS total_revenue_today,
    (SELECT COUNT(*) FROM driver_profiles
     WHERE status IN ('pending_verification','under_review'))
      AS pending_verifications,
    (SELECT COUNT(*) FROM incident_reports
     WHERE status IN ('open','investigating'))
      AS open_incidents;
END;
$function$;

-- Admin-only wallet aggregates (incl. total money in circulation).
CREATE OR REPLACE FUNCTION public.get_admin_wallet_stats()
 RETURNS TABLE(total_in_circulation bigint, pending_redemptions_count bigint, pending_redemptions_amount bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT
    (SELECT COALESCE(SUM(balance), 0) FROM wallet_accounts
     WHERE is_active = true)
      AS total_in_circulation,
    (SELECT COUNT(*) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_count,
    (SELECT COALESCE(SUM(amount), 0) FROM wallet_redemptions
     WHERE status = 'requested')
      AS pending_redemptions_amount;
END;
$function$;

-- Owner-or-admin only: a wallet summary must not be readable for an
-- arbitrary p_user_id by another logged-in user.
CREATE OR REPLACE FUNCTION public.get_wallet_summary(p_user_id uuid, p_account_type wallet_account_type DEFAULT 'customer_cash'::wallet_account_type)
 RETURNS TABLE(available_balance integer, held_balance integer, total_earned integer, total_spent integer, currency text, account_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT wa.id
    INTO v_account_id
  FROM wallet_accounts wa
  WHERE wa.user_id = p_user_id
    AND wa.account_type = p_account_type
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, 0, 'TRC'::text, NULL::uuid;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(wa.balance, 0)::int        AS available_balance,
    COALESCE(wa.held_balance, 0)::int   AS held_balance,
    COALESCE((
      SELECT SUM(le.amount)::int
      FROM ledger_entries le
      WHERE le.account_id = v_account_id
        AND le.amount > 0
    ), 0)                               AS total_earned,
    COALESCE((
      SELECT SUM(-le.amount)::int
      FROM ledger_entries le
      WHERE le.account_id = v_account_id
        AND le.amount < 0
    ), 0)                               AS total_spent,
    'TRC'::text                         AS currency,
    v_account_id                        AS account_id
  FROM wallet_accounts wa
  WHERE wa.id = v_account_id;
END;
$function$;

-- Owner-or-admin only: a driver's quota/balance status.
CREATE OR REPLACE FUNCTION public.get_driver_quota_status(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance INTEGER := 0;
  v_total_recharged INTEGER := 0;
  v_deduction_rate NUMERIC := 0.15;
  v_low_threshold INTEGER := 500;
  v_warning_active BOOLEAN := false;
  v_grace_remaining INTEGER := 0;
  v_blocked BOOLEAN := false;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_user_id AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance
  FROM wallet_accounts
  WHERE user_id = p_user_id AND account_type = 'tricicoin'
  LIMIT 1;

  SELECT COALESCE(SUM(le.amount), 0) INTO v_total_recharged
  FROM ledger_entries le
  JOIN wallet_accounts wa ON wa.id = le.account_id
  JOIN ledger_transactions lt ON lt.id = le.transaction_id
  WHERE wa.user_id = p_user_id
    AND wa.account_type = 'tricicoin'
    AND le.amount > 0
    AND lt.type IN ('recharge','adjustment','reversal');

  SELECT (value #>> '{}')::NUMERIC INTO v_deduction_rate
  FROM platform_config WHERE key='quota_deduction_rate';
  v_deduction_rate := COALESCE(v_deduction_rate, 0.15);

  v_warning_active := v_balance < v_low_threshold;
  v_blocked := v_balance <= 0;
  v_grace_remaining := CASE WHEN v_blocked THEN 0 ELSE 999 END;

  RETURN jsonb_build_object(
    'balance', v_balance,
    'total_recharged', v_total_recharged,
    'warning_active', v_warning_active,
    'grace_trips_remaining', v_grace_remaining,
    'blocked', v_blocked,
    'deduction_rate', v_deduction_rate
  );
END;
$function$;
