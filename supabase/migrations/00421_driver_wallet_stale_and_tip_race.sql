-- 00421_driver_wallet_stale_and_tip_race.sql
-- ============================================================================
-- Three money-correctness defects from the multi-agent audit (2026-06-14).
-- None mint/burn (global conservation holds); they operate on the wrong (dead)
-- wallet or skip a lock. All patched in-place from the live prod bodies so no
-- feature is lost (same class as 00340/00386/00390 driver_cash->tricicoin).
--
-- MONEY-01 (P2): approve_redemption (driver cash-out) reads/debits the
--   deprecated driver_cash wallet; real driver earnings live in tricicoin. Once
--   cash-out is wired, the balance check fails (driver can't withdraw) or it
--   debits the wrong wallet. 0 callers today. Fix: driver_cash -> tricicoin.
--
-- MONEY-02 (P3): admin_refund_ride_commission looks for the commission debit on
--   driver_cash (where modern rides have no entries) -> raises 'No commission to
--   refund' for every recent ride; and would credit driver_cash (invisible).
--   No UI caller; fails closed. Fix: both occurrences driver_cash -> tricicoin.
--
-- MONEY-03 (P3): add_tip reads the sender wallet balance WITHOUT FOR UPDATE, so
--   two concurrent tips can both pass the gate and overspend (negative balance;
--   does not mint — entries still net 0). Fix: lock the sender wallet row.
--
-- MONEY-04 (money-health-check #10 false-positives) intentionally deferred — it
-- is a tooling-only refinement and scoping it correctly needs the exact ledger
-- single-sided model; tracked separately.
-- ============================================================================

-- MONEY-01: approve_redemption driver_cash -> tricicoin (1 occurrence).
DO $p$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.approve_redemption(uuid,uuid)'::regprocedure) INTO v_src;
  IF v_src IS NOT NULL AND position('''driver_cash''' IN v_src) > 0 THEN
    EXECUTE replace(v_src, '''driver_cash''', '''tricicoin''');
    RAISE NOTICE 'approve_redemption: driver_cash -> tricicoin';
  ELSE
    RAISE NOTICE 'approve_redemption: no driver_cash literal; skipping';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'approve_redemption absent; skipping';
END $p$;

-- MONEY-02: admin_refund_ride_commission driver_cash -> tricicoin (2 occurrences).
DO $p$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef('public.admin_refund_ride_commission(uuid,uuid,text)'::regprocedure) INTO v_src;
  IF v_src IS NOT NULL AND position('''driver_cash''' IN v_src) > 0 THEN
    EXECUTE replace(v_src, '''driver_cash''', '''tricicoin''');
    RAISE NOTICE 'admin_refund_ride_commission: driver_cash -> tricicoin';
  ELSE
    RAISE NOTICE 'admin_refund_ride_commission: no driver_cash literal; skipping';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'admin_refund_ride_commission absent; skipping';
END $p$;

-- MONEY-03: add_tip — lock the sender wallet row before the balance check.
DO $p$
DECLARE
  v_src text;
  v_target CONSTANT text := 'WHERE user_id = p_from_user_id AND account_type = ''customer_cash'';';
  v_repl   CONSTANT text := 'WHERE user_id = p_from_user_id AND account_type = ''customer_cash''' || E'\n    FOR UPDATE;';
BEGIN
  SELECT pg_get_functiondef('public.add_tip(uuid,uuid,integer)'::regprocedure) INTO v_src;
  IF v_src IS NOT NULL AND position(v_target IN v_src) > 0 THEN
    EXECUTE replace(v_src, v_target, v_repl);
    RAISE NOTICE 'add_tip: added FOR UPDATE to sender wallet lock';
  ELSE
    RAISE NOTICE 'add_tip: lock target not found (already patched?); skipping';
  END IF;
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'add_tip absent; skipping';
END $p$;
