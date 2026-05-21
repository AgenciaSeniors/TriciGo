-- ============================================================
-- Migration 00276: Per-user top-up velocity controls
--
-- The card top-up flow (create-stripe-payment-intent) limits each
-- recharge per-transaction (min/max amount) and per-IP (5 req/min),
-- but nothing caps how often or how much a single USER recharges
-- over time. Payment-processor underwriting expects per-user
-- "velocity controls" as a card-fraud / abuse safeguard.
--
-- This migration adds:
--   - two tunable limits in platform_config
--   - check_topup_velocity(): an RPC the recharge edge function
--     calls before it creates a charge.
--
-- Velocity is computed against payment_intents directly (the source
-- of truth for completed charges). The rate_limits table (00105) is
-- NOT used: its cleanup_rate_limits() cron deletes rows after 2h, so
-- it cannot back a 24h / 30d window.
-- ============================================================

-- ─── 1. PLATFORM CONFIG: VELOCITY LIMITS ──────────────────────
-- Defaults from PAYMENT_COMPANION.md §5. Tunable without a deploy
-- by UPDATEing these rows (e.g. from the admin panel).
INSERT INTO platform_config (key, value) VALUES
  ('velocity_max_recharges_24h', '3'),
  ('velocity_max_amount_usd_30d', '1000')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. RPC: CHECK TOP-UP VELOCITY ────────────────────────────
-- Called by create-stripe-payment-intent before a charge is created.
-- Returns jsonb { allowed: bool, reason?, limit?, current? }.
-- Counts only COMPLETED, non-corporate recharges — corporate
-- top-ups are a separate vetted B2B flow, exempt at the call site.
CREATE OR REPLACE FUNCTION check_topup_velocity(
  p_user_id uuid,
  p_amount_usd numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_max_24h    integer;
  v_max_30d    numeric;
  v_count_24h  integer;
  v_sum_30d    numeric;
BEGIN
  -- Limits from platform_config, with COALESCE to safe defaults.
  SELECT (value::integer) INTO v_max_24h
  FROM platform_config WHERE key = 'velocity_max_recharges_24h';
  v_max_24h := COALESCE(v_max_24h, 3);

  SELECT (value::numeric) INTO v_max_30d
  FROM platform_config WHERE key = 'velocity_max_amount_usd_30d';
  v_max_30d := COALESCE(v_max_30d, 1000);

  -- (a) Count of completed recharges in the last 24 hours.
  SELECT COUNT(*) INTO v_count_24h
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status = 'completed'
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '24 hours';

  IF v_count_24h >= v_max_24h THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  'max_recharges_24h',
      'limit',   v_max_24h,
      'current', v_count_24h
    );
  END IF;

  -- (b) Sum of completed recharge value (USD) in the last 30 days.
  SELECT COALESCE(SUM(amount_usd), 0) INTO v_sum_30d
  FROM payment_intents
  WHERE user_id = p_user_id
    AND status = 'completed'
    AND corporate_account_id IS NULL
    AND created_at >= NOW() - INTERVAL '30 days';

  IF v_sum_30d + COALESCE(p_amount_usd, 0) > v_max_30d THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  'max_amount_30d',
      'limit',   v_max_30d,
      'current', v_sum_30d
    );
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

-- ─── 3. GRANTS ────────────────────────────────────────────────
-- Only the recharge edge function (service-role key) calls this RPC.
REVOKE EXECUTE ON FUNCTION check_topup_velocity(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_topup_velocity(uuid, numeric) TO service_role;

COMMENT ON FUNCTION check_topup_velocity(uuid, numeric) IS
  'Phase B1: per-user card top-up velocity control. Returns jsonb {allowed, reason?, limit?, current?}. Counts completed non-corporate payment_intents over 24h (count) and 30d (USD sum). Called by create-stripe-payment-intent before creating a charge.';
