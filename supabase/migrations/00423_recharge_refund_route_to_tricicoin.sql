-- 00423_recharge_refund_route_to_tricicoin.sql
-- ============================================================================
-- WPS-02 (P2, audit 2026-06-14): process_recharge_refund always debits
-- customer_cash, but a DRIVER recharge (recharge_type IN ('tricicoin',
-- 'driver_quota')) is CREDITED to the driver's tricicoin wallet by
-- process_recharge_payment (mig 00300 single-wallet routing). So a refund of a
-- driver recharge debits the wrong wallet:
--   * if the driver has no customer_cash account → RAISE 'Wallet account not
--     found' → the webhook returns 500 → NETOPIA retries forever, refund never
--     reconciles, driver keeps the free TRC; or
--   * if they do → customer_cash is driven negative for value never credited
--     there, and the real tricicoin recharge is never reversed.
-- Either way the ledger stops reflecting reality.
--
-- Fix: route the refund to the SAME wallet the recharge credited — mirror
-- process_recharge_payment: non-corporate driver recharges → tricicoin, else
-- customer_cash. In-place patch of the live body (only the ELSE account-type
-- selection changes; idempotency, FOR UPDATE, ledger entry are untouched).
-- ============================================================================

DO $patch$
DECLARE
  v_src text;
  v_target CONSTANT text := '    v_account_type := ''customer_cash'';';
  v_repl CONSTANT text :=
    '    IF v_intent.recharge_type IN (''tricicoin'', ''driver_quota'') THEN' || E'\n' ||
    '      v_account_type := ''tricicoin'';' || E'\n' ||
    '    ELSE' || E'\n' ||
    '      v_account_type := ''customer_cash'';' || E'\n' ||
    '    END IF;';
BEGIN
  SELECT pg_get_functiondef('public.process_recharge_refund(uuid,jsonb)'::regprocedure) INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE 'process_recharge_refund absent; skipping';
  ELSIF position('recharge_type IN' IN v_src) > 0 THEN
    RAISE NOTICE 'process_recharge_refund already routes by recharge_type; skipping';
  ELSIF position(v_target IN v_src) > 0 THEN
    EXECUTE replace(v_src, v_target, v_repl);
    RAISE NOTICE 'process_recharge_refund: refund now routes driver recharges to tricicoin';
  ELSE
    RAISE NOTICE 'process_recharge_refund: customer_cash target not found; manual review';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'process_recharge_refund absent; skipping';
END $patch$;
