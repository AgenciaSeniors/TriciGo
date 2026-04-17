-- ============================================================
-- Migration 00128: Driver wallet fixes + earnings-by-zone analytics
--
-- Fixes:
--   1. get_wallet_summary only looked at 'customer_cash' accounts,
--      so the driver wallet screen showed the rider balance instead
--      of the driver's earnings balance.
--   2. get_wallet_summary hardcoded total_earned=0 / total_spent=0.
--      Now computed as SUM over ledger_entries (positive / negative).
--   3. Return account_id so callers can paginate ledger transactions
--      without a second lookup.
--
-- New:
--   - get_driver_earnings_by_zone(driver_id, start, end) — top 5
--     zones by earnings for the driver's completed rides in range,
--     grouped via ST_Contains(zones.boundary, rides.pickup_location).
-- ============================================================

-- ---- 1. get_wallet_summary — replace with parameterized version ----
DROP FUNCTION IF EXISTS get_wallet_summary(uuid);

CREATE OR REPLACE FUNCTION get_wallet_summary(
  p_user_id       uuid,
  p_account_type  wallet_account_type DEFAULT 'customer_cash'
) RETURNS TABLE (
  available_balance INTEGER,
  held_balance      INTEGER,
  total_earned      INTEGER,
  total_spent       INTEGER,
  currency          TEXT,
  account_id        UUID
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT id INTO v_account_id
  FROM wallet_accounts
  WHERE user_id = p_user_id AND account_type = p_account_type
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN QUERY
      SELECT 0, 0, 0, 0, 'TRC'::text, NULL::uuid;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(wa.balance, 0)::int        AS available_balance,
    COALESCE(wa.held_balance, 0)::int   AS held_balance,
    COALESCE((
      SELECT SUM(amount)::int FROM ledger_entries
      WHERE account_id = v_account_id AND amount > 0
    ), 0)                               AS total_earned,
    COALESCE((
      SELECT SUM(-amount)::int FROM ledger_entries
      WHERE account_id = v_account_id AND amount < 0
    ), 0)                               AS total_spent,
    'TRC'::text                         AS currency,
    v_account_id                        AS account_id
  FROM wallet_accounts wa
  WHERE wa.id = v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION get_wallet_summary(uuid, wallet_account_type) TO authenticated;

-- ---- 2. get_driver_earnings_by_zone ----
CREATE OR REPLACE FUNCTION get_driver_earnings_by_zone(
  p_driver_id uuid,
  p_start     timestamptz,
  p_end       timestamptz
) RETURNS TABLE (
  zone_id               uuid,
  zone_name             text,
  trip_count            integer,
  total_fare_cup        bigint,
  total_earnings_cup    bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_commission numeric;
BEGIN
  -- Caller must be the driver (owner of the driver_profile) or admin
  IF NOT EXISTS (
    SELECT 1 FROM driver_profiles
    WHERE id = p_driver_id AND user_id = auth.uid()
  ) AND NOT is_admin() THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- platform_config.value is jsonb; commission_rate stored as a JSON number.
  SELECT COALESCE((value)::numeric, 0.15)
  INTO v_commission
  FROM platform_config WHERE key = 'commission_rate' LIMIT 1;

  IF v_commission IS NULL THEN
    v_commission := 0.15;
  END IF;

  RETURN QUERY
  SELECT
    z.id,
    z.name,
    count(r.id)::int                                            AS trip_count,
    COALESCE(sum(r.final_fare_cup), 0)::bigint                  AS total_fare_cup,
    COALESCE(sum((r.final_fare_cup * (1.0 - v_commission))::int), 0)::bigint
                                                                AS total_earnings_cup
  FROM rides r
  JOIN zones z ON z.is_active
    AND ST_Contains(z.boundary::geometry, r.pickup_location::geometry)
  WHERE r.driver_id = p_driver_id
    AND r.status = 'completed'
    AND r.completed_at BETWEEN p_start AND p_end
  GROUP BY z.id, z.name
  HAVING count(r.id) > 0
  ORDER BY total_earnings_cup DESC
  LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION get_driver_earnings_by_zone(uuid, timestamptz, timestamptz) TO authenticated;
