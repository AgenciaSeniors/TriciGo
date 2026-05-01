-- ============================================================
-- admin_send_wallet_v2_bonus_push: one-shot announcement RPC
-- ============================================================
-- Wallet v2 phase 2 part B. After 00242 migrated balances and
-- gave passenger/corporate accounts a 5% bonus, users need to be
-- told. The push notification can't be triggered straight from the
-- admin browser (the send-push EF requires service_role apikey,
-- which the browser must not expose), so this admin-gated RPC
-- relays via pg_net using the vault-stored service-role key.
--
-- Targets every wallet_accounts row with migration_bonus_pct > 0
-- (i.e. customer_cash, tricicoin, corporate_cash). Each user gets
-- one push per call. Idempotency is the admin's responsibility —
-- repeated calls fire repeated notifications.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_send_wallet_v2_bonus_push()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_target_user uuid;
  v_balance_usd numeric;
  v_bonus_pct numeric;
  v_bonus_usd numeric;
  v_count integer := 0;
  v_supabase_url text := 'https://lqaufszburqvlslpcuac.supabase.co';
  v_service_key text;
  v_title text;
  v_body text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RAISE EXCEPTION 'service_role_key vault entry missing';
  END IF;

  -- One push per wallet account that received the bonus.
  -- DISTINCT on user_id to avoid sending twice if a user has two
  -- bonus-eligible accounts (e.g. customer_cash + tricicoin).
  FOR v_target_user, v_balance_usd, v_bonus_pct IN
    SELECT DISTINCT ON (wa.user_id)
           wa.user_id,
           ROUND(wa.balance_usd_cents::numeric / 100, 2),
           wa.migration_bonus_pct
    FROM wallet_accounts wa
    WHERE wa.migration_bonus_pct > 0
      AND wa.balance_usd_cents IS NOT NULL
      AND wa.user_id IS NOT NULL
    ORDER BY wa.user_id, wa.balance_usd_cents DESC
  LOOP
    v_bonus_usd := ROUND(v_balance_usd / (1 + v_bonus_pct/100) * (v_bonus_pct/100), 2);
    v_title := '🎁 ¡Nuevo TriciCoin con bono!';
    v_body := 'Tu saldo ahora se muestra en USD. Te regalamos ~$'
              || v_bonus_usd::text || ' (' || v_bonus_pct::int::text
              || '%) como bienvenida. Saldo actual: $' || v_balance_usd::text || '.';

    PERFORM net.http_post(
      url := v_supabase_url || '/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', v_service_key,
        'Authorization', 'Bearer ' || v_service_key
      ),
      body := jsonb_build_object(
        'user_id', v_target_user,
        'title', v_title,
        'body', v_body,
        'category', 'wallet_v2_migration',
        'data', jsonb_build_object('type', 'wallet_v2_migration', 'bonus_usd', v_bonus_usd::text)
      )
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'pushes_dispatched', v_count,
    'note', 'Each push goes through send-push EF; check user_devices for delivery and net._http_response for the EF responses.'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_send_wallet_v2_bonus_push() TO authenticated;

-- Verification (dry-count without sending):
--   SELECT count(DISTINCT user_id) FROM wallet_accounts
--    WHERE migration_bonus_pct > 0 AND balance_usd_cents IS NOT NULL AND user_id IS NOT NULL;
--   -- expected: ~8 users in current prod (PR #33 dry-run)
