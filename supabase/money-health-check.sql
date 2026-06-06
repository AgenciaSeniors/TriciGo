-- ============================================================================
-- TriciGo — Money health check (repeatable invariants)
-- ============================================================================
-- Run against prod (read-only). Each query returns ROWS ONLY WHEN SOMETHING IS
-- WRONG — a clean system returns 0 rows for checks 1-7. Checks 8-9 are
-- informational (always return a row).
--
-- Origin: the comprehensive money audit (2026-06-06). These are the invariants
-- that held across Phases 1-7. Re-run after any change to a money RPC, the
-- ledger, recharge/webhook, or pricing.
--
-- Background invariants:
--   * wallet_accounts.balance is a materialized cache of SUM(ledger_entries).
--   * TriciCoin is 1:1 CUP (cup_to_trc_centavos = ROUND(cup); fix 00379).
--   * Snapshot rides charge final = estimate - discount + wait (strict parity).
--   * Cancellation is reputational since ~2026-06-03 (charges $0).
-- ============================================================================

-- 1) BALANCE DRIFT — the strict invariant. balance must equal SUM(entries).
--    Any row = a wallet whose materialized balance diverged from the ledger.
SELECT 'DRIFT' AS check, wa.id::text AS account_id, u.full_name AS owner,
       wa.account_type::text AS account_type, wa.balance,
       COALESCE(ls.computed, 0) AS ledger_sum,
       wa.balance - COALESCE(ls.computed, 0) AS drift
FROM wallet_accounts wa
LEFT JOIN (SELECT account_id, SUM(amount) AS computed FROM ledger_entries GROUP BY account_id) ls
       ON ls.account_id = wa.id
LEFT JOIN users u ON u.id = wa.user_id
WHERE wa.balance <> COALESCE(ls.computed, 0);

-- 2) RECHARGE INTEGRITY — every completed payment_intent must have credited the
--    wallet for exactly amount_cup. Any row = charged-but-not-credited / wrong amount.
SELECT 'RECHARGE_MISMATCH' AS check, pi.id::text AS intent, pi.recharge_type, pi.amount_cup,
       COALESCE((SELECT SUM(le.amount) FROM ledger_entries le WHERE le.transaction_id = pi.transaction_id), 0) AS credited
FROM payment_intents pi
WHERE pi.status IN ('completed','paid')
  AND pi.amount_cup <> COALESCE((SELECT SUM(le.amount) FROM ledger_entries le WHERE le.transaction_id = pi.transaction_id), 0);

-- 3) FAILED/EXPIRED NOT CREDITED — a failed/expired intent must never carry a credit.
SELECT 'GHOST_CREDIT' AS check, pi.id::text AS intent, pi.status, pi.amount_cup,
       (SELECT SUM(le.amount) FROM ledger_entries le WHERE le.transaction_id = pi.transaction_id) AS credited
FROM payment_intents pi
WHERE pi.status IN ('failed','expired')
  AND COALESCE((SELECT SUM(le.amount) FROM ledger_entries le WHERE le.transaction_id = pi.transaction_id), 0) <> 0;

-- 4) TRC == CUP — recent tricicoin/mixed completed rides must have 1:1 fares
--    (regression guard for cup_to_trc_centavos — bug 00379). Any row = mis-charge.
SELECT 'TRC_CUP_GAP' AS check, left(r.id::text,8) AS ride, r.payment_method::text AS pm,
       r.final_fare_cup, r.final_fare_trc
FROM rides r
WHERE r.status = 'completed' AND r.payment_method IN ('tricicoin','mixed')
  AND r.final_fare_trc IS NOT NULL
  AND r.final_fare_cup <> r.final_fare_trc
  -- Floor at the first full day after the 00379 fix (applied late 2026-06-04)
  -- so pre-fix historical casualties don't flag; this only catches a
  -- REGRESSION (a post-fix ride with trc <> cup).
  AND r.completed_at > GREATEST(now() - interval '30 days', timestamptz '2026-06-05');

-- 5) PARITY — snapshot rides: final must equal estimate - discount + wait.
--    Any row = the rider was charged something other than what they were quoted.
SELECT 'PARITY_GAP' AS check, left(r.id::text,8) AS ride, r.payment_method::text AS pm,
       r.estimated_fare_cup AS estimate, r.final_fare_cup AS final,
       COALESCE(r.discount_amount_cup,0) AS discount, COALESCE(r.wait_time_charge_cup,0) AS wait,
       r.final_fare_cup - (r.estimated_fare_cup - COALESCE(r.discount_amount_cup,0) + COALESCE(r.wait_time_charge_cup,0)) AS gap
FROM rides r
WHERE r.status = 'completed'
  AND EXISTS (SELECT 1 FROM ride_pricing_snapshots s WHERE s.ride_id = r.id AND s.snapshot_type='estimate')
  AND r.final_fare_cup <> (r.estimated_fare_cup - COALESCE(r.discount_amount_cup,0) + COALESCE(r.wait_time_charge_cup,0))
  AND r.completed_at > now() - interval '30 days';

-- 6) CANCELLATION CHARGES $0 — reputational model: no money on canceled rides.
--    Any row = cancellation charged money (regression of the reputation model).
SELECT 'CANCEL_CHARGE' AS check, lt.id::text AS txn, lt.reference_type, lt.created_at
FROM ledger_transactions lt
WHERE lt.reference_type IN ('cancellation_penalty','cancellation_fee')
  AND lt.created_at > '2026-06-03';

-- 7) CONVERSION 1:1 — cup_to_trc_centavos must return ROUND(cup) (ignore rate).
SELECT 'CONVERSION_BROKEN' AS check, public.cup_to_trc_centavos(1000, 520) AS got, 1000 AS expected
WHERE public.cup_to_trc_centavos(1000, 520) <> 1000;

-- 8) WALLET INVENTORY (informational) — totals per account_type + negatives.
--    driver_cash/driver_quota are deprecated (frozen legacy); should not grow.
SELECT 'INVENTORY' AS check, wa.account_type::text AS account_type,
       COUNT(*) AS accounts, SUM(wa.balance) AS total_balance,
       COUNT(*) FILTER (WHERE wa.balance < 0) AS negative_accounts,
       to_char(max(le.created_at),'YYYY-MM-DD') AS last_entry
FROM wallet_accounts wa
LEFT JOIN ledger_entries le ON le.account_id = wa.id
GROUP BY wa.account_type ORDER BY account_type;

-- 9) PLATFORM REVENUE COMPOSITION (informational) — commissions in, refunds out.
SELECT 'PLATFORM_REVENUE' AS check, lt.type::text AS tx_type, COUNT(*) AS txns, SUM(le.amount) AS total
FROM ledger_entries le
JOIN ledger_transactions lt ON lt.id = le.transaction_id
JOIN wallet_accounts wa ON wa.id = le.account_id AND wa.account_type='platform_revenue'
GROUP BY lt.type ORDER BY total DESC;
