-- 00324 — Fix `get_wallet_summary` "column reference account_id is ambiguous"
-- =============================================================================
--
-- Symptom (verified in prod 2026-05-26):
--   SELECT * FROM get_wallet_summary('<uuid>'::uuid, 'tricicoin');
--   → ERROR 42702: column reference "account_id" is ambiguous
--   → DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- Impact: EVERY driver + customer wallet read fails. Frontend
-- (apps/driver/app/(tabs)/wallet.tsx, packages/api/src/services/wallet.service.ts)
-- catches the error silently and defaults `summary` to `{available_balance: 0, ...}`.
-- Users see "Saldo disponible: 0 CUP" everywhere even when DB balance is real.
--
-- Eduardo Admin example: tricicoin.balance = 53,315 CUP / $3.93 USD, but UI
-- displays 0 because RPC throws.
--
-- Root cause: the function declares
--   RETURNS TABLE(..., account_id uuid)
-- which implicitly creates an OUT variable named `account_id`. Inside the
-- RETURN QUERY's subqueries:
--   SELECT SUM(amount) FROM ledger_entries
--   WHERE account_id = v_account_id          -- ← ambiguous
-- Postgres cannot distinguish if `account_id` refers to
--   (a) `ledger_entries.account_id` column, or
--   (b) the OUT TABLE column `account_id`.
--
-- Fix: alias the table (`ledger_entries le`) and qualify ALL column references
-- (`le.account_id`, `le.amount`). Also explicitly qualify `wa.*` everywhere in
-- the outer SELECT for consistency.
--
-- This is a pure CREATE OR REPLACE — no DML, no schema change, idempotent.
-- Locking impact: trivial (single function redefinition).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_wallet_summary(
  p_user_id uuid,
  p_account_type wallet_account_type DEFAULT 'customer_cash'
)
RETURNS TABLE(
  available_balance integer,
  held_balance integer,
  total_earned integer,
  total_spent integer,
  currency text,
  account_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT wa.id
    INTO v_account_id
  FROM wallet_accounts wa
  WHERE wa.user_id = p_user_id
    AND wa.account_type = p_account_type
  LIMIT 1;

  -- No wallet row for this (user, account_type) → return zeros (not an error,
  -- consistent with previous behavior).
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
$$;

GRANT EXECUTE ON FUNCTION public.get_wallet_summary(uuid, wallet_account_type) TO authenticated;

COMMENT ON FUNCTION public.get_wallet_summary(uuid, wallet_account_type) IS
  '00324 fix: qualify all ledger_entries refs (le.account_id, le.amount) inside the RETURN QUERY subqueries. The `RETURNS TABLE(..., account_id uuid)` clause implicitly declared an OUT variable named `account_id` that shadowed the table column, causing 42702 ambiguous-column errors on every call. After fix: SELECT * FROM get_wallet_summary(<uuid>, ''tricicoin'') returns the real balance instead of throwing.';
