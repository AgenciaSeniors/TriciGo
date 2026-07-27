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
--    Pre-wipe survivors (created before the 2026-06-07 pre-launch wipe) carry a
--    BENIGN opening-balance drift: the wipe deleted their pre-wipe ledger history but
--    kept the balance, so SUM(entries) is missing the opening balance. They are
--    excluded here so this check only flags REAL drift on post-wipe wallets.
--    To fully reconcile them (make SUM(entries)==balance), a human can insert a
--    one-off genesis "Saldo de apertura" entry per wallet equal to the drift, WITHOUT
--    changing balance and restoring anchor_usd_cents/unbacked_cup afterwards so the
--    anchor trigger's recompute doesn't corrupt the anchor:
--      BEGIN;
--      -- per drift wallet W with drift D:
--      --   snapshot S := (anchor_usd_cents, unbacked_cup) of W
--      --   INSERT ledger_transactions(type='adjustment', metadata->>'kind'='genesis_rebaseline', created_at=W.created_at) -> T
--      --   INSERT ledger_entries(T, W, D, D)             -- balance is NOT updated
--      --   UPDATE wallet_accounts SET anchor_usd_cents=S.anchor, unbacked_cup=S.unbacked WHERE id=W
--      COMMIT;
SELECT 'DRIFT' AS check, wa.id::text AS account_id, u.full_name AS owner,
       wa.account_type::text AS account_type, wa.balance,
       COALESCE(ls.computed, 0) AS ledger_sum,
       wa.balance - COALESCE(ls.computed, 0) AS drift
FROM wallet_accounts wa
LEFT JOIN (SELECT account_id, SUM(amount) AS computed FROM ledger_entries GROUP BY account_id) ls
       ON ls.account_id = wa.id
LEFT JOIN users u ON u.id = wa.user_id
WHERE wa.balance <> COALESCE(ls.computed, 0)
  AND wa.created_at >= timestamptz '2026-06-07';  -- exclude benign pre-wipe opening-balance drift

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

-- 10) DOUBLE-ENTRY — three distinct defects, one query. Added 2026-06-13,
--     narrowed 2026-07-27 (see below).
--
--       (a) a transaction with NO entries at all — recorded, but no money moved;
--       (b) a SINGLE-entry transaction of an INTERNAL type — a leg that was never
--           written. This is exactly the cargo-bonus class: before 00414 it credited
--           the driver with no platform debit;
--       (c) a MULTI-LEG transaction that does not net to 0 — money minted or burned
--           mid-transfer.
--
--     `recharge`, `adjustment` and `refund` are the ONLY types allowed to stand alone:
--     their counterparty is a card or platform goodwill, not another wallet. This
--     mirrors the exclusion 10b already documents, which the original check omitted.
--
--     WHY THIS WAS NARROWED. As written, this check flagged every single-entry
--     transaction, so it reported the by-design external ones as "minted/burned money
--     without a counterparty". It read as 0 rows on 2026-07-01 only because no admin
--     adjustments existed yet; the launch bonuses (Fundador and the driver bonuses,
--     2026-07-04 onward) pushed it to 90 rows of pure noise — under the most alarming
--     heading in the file, on the one script that is supposed to be trustworthy about
--     money. A check that always fires teaches you to skip it, which is worse than not
--     having it.
--
--     Verified against production 2026-07-27: every internal type is 100% multi-leg
--     (fx_revaluation 122, commission 8, promo_credit 7, transfer_out 6, ride_payment 4,
--     transfer_in 1 — zero single-entry among them), so the allow-list costs no real
--     coverage. Confirmed by simulation in a rolled-back transaction that a single-entry
--     `commission` is still caught and labelled.
SELECT 'UNBALANCED_TXN' AS check, lt.id::text AS txn, lt.type::text AS tx_type,
       lt.idempotency_key, COUNT(le.id) AS entries, COALESCE(SUM(le.amount), 0) AS net,
       CASE WHEN COUNT(le.id) = 0 THEN 'transaction has no entries at all'
            WHEN COUNT(le.id) = 1 THEN 'single entry on an internal type: a leg was never written'
            ELSE 'multi-leg transaction does not net to zero' END AS defect
FROM ledger_transactions lt
LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
GROUP BY lt.id, lt.type, lt.idempotency_key
HAVING COUNT(le.id) = 0
    OR (COUNT(le.id) = 1 AND lt.type::text NOT IN ('recharge', 'adjustment', 'refund'))
    OR (COUNT(le.id) >= 2 AND COALESCE(SUM(le.amount), 0) <> 0);

-- 10b) GLOBAL DOUBLE-ENTRY IMBALANCE — entries belonging to MULTI-LEG (internal)
--      transactions must net to 0 globally. Single-entry txns are external by design
--      and excluded: recharge credits (counterparty = card), refunds (card),
--      admin adjustments / genesis (platform goodwill / opening balance). The naive
--      "sum of ALL entries == 0" is WRONG for this ledger because recharges legitimately
--      inject external value (sum today = 60,040 = 55,040 recharges + 5,000 admin credit).
SELECT 'GLOBAL_LEDGER_IMBALANCE' AS check, COALESCE(SUM(le.amount), 0) AS internal_double_entry_sum
FROM ledger_entries le
WHERE le.transaction_id IN (
  SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING COUNT(*) >= 2
)
HAVING COALESCE(SUM(le.amount), 0) <> 0;

-- 11) FX ANCHOR SANITY (informational) — anchored wallets whose CUP balance can't be
--     explained by the USD anchor + unbacked (gross breakage only: a negative anchor,
--     or a positive balance with ZERO backing — e.g. the refund-residue class). Small
--     intra-day gaps from the daily revaluation lag are expected and NOT flagged.
SELECT 'FX_ANCHOR_SANITY' AS check, wa.id::text AS account_id, wa.account_type::text AS account_type,
       wa.balance, wa.anchor_usd_cents, COALESCE(wa.unbacked_cup, 0) AS unbacked_cup
FROM wallet_accounts wa
WHERE wa.account_type IN ('customer_cash', 'corporate_cash', 'tricicoin')
  AND (
    wa.anchor_usd_cents < 0
    OR (wa.balance > 50 AND COALESCE(wa.anchor_usd_cents, 0) = 0 AND COALESCE(wa.unbacked_cup, 0) = 0)
  );

-- 12) PLATFORM FX RESERVE (informational) — the treasury liability the platform mints
--     to preserve users' USD value. Goes negative as the dollar rises sustainedly. Not
--     an integrity issue (double-entry always balances), but watch the trend as the
--     anchored base grows. Shows current balance + the net fx delta over the last 30d.
SELECT 'FX_RESERVE' AS check, wa.balance AS reserve_balance,
       COALESCE((SELECT SUM(le.amount) FROM ledger_entries le
                 JOIN ledger_transactions lt ON lt.id = le.transaction_id
                 WHERE le.account_id = wa.id AND lt.type = 'fx_revaluation'
                   AND lt.created_at > now() - interval '30 days'), 0) AS fx_delta_30d
FROM wallet_accounts wa
WHERE wa.account_type = 'platform_fx_reserve';

-- 13) EXCHANGE RATE STALENESS (warning) — the is_current rate drives anchoring,
--     revaluation, and pricing. If the eltoque feed freezes, this row appears. The
--     threshold mirrors platform_config.exchange_rate_max_age_hours (default 24).
SELECT 'RATE_STALE' AS check, er.usd_cup_rate, er.source, er.fetched_at,
       round(extract(epoch FROM (now() - er.fetched_at)) / 3600.0, 1) AS age_hours
FROM exchange_rates er
WHERE er.is_current = true
  AND er.fetched_at < now() - make_interval(hours => COALESCE(
        (SELECT (value #>> '{}')::numeric FROM platform_config WHERE key = 'exchange_rate_max_age_hours'), 24)::int);
