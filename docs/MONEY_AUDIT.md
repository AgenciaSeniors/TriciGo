# Money Audit — TriciGo (2026-06-06)

Comprehensive audit of **everything that touches money**: ledger, wallets, recharge,
pricing, ride charge, secondary flows (tips/gifts/bonus/cancellation), money-out, and
cross-app display. Method per phase: explore code → **ground against PROD** (the live
RPC bodies + diagnostic SQL) → confirm each candidate is real before fixing → fix →
verify (`pnpm check-types` + vitest + SQL re-check). Lens applied to each subsystem:
logic / code / incompatibilities / UI-UX.

**Headline:** the money core is **sound**. The recent bugs the user hit were already
fixed in prior PRs; the audit confirmed prod is clean and turned up only legacy/test
data, dormant feature paths, and minor cosmetics. **Re-run the invariants any time via
[`supabase/money-health-check.sql`](../supabase/money-health-check.sql)** (rows = problems).

## Cross-cutting invariants (all verified green)

| Invariant | Result |
|---|---|
| Balance drift — `wallet_accounts.balance == SUM(ledger_entries)` per account | ✅ 0 drift (all 7 account types) |
| TriciCoin 1:1 CUP — `cup_to_trc_centavos = ROUND(cup)` | ✅ (fix 00379 holds) |
| Parity — snapshot rides charge `final = estimate − discount + wait` | ✅ `gap=0` on all recent rides |
| Recharge — completed intents credit the exact `amount_cup` | ✅ 12/12 exact; 0 stuck; failed/expired never credited |
| Commission — `tricicoin (−) → platform_revenue (+)` | ✅ current path correct |
| `platform_revenue` reconciles to its ledger entries | ✅ exact (93,352) |
| Cancellation charges $0 (reputational model) | ✅ 0 charges since ~06-03 |

## Phase results

- **P1 Ledger + wallets** — ✅ zero drift. `driver_cash` (deprecated) holds 228,586 incl. 3 negatives, **frozen since April, no live writer** → confirmed **test accounts, left as-is** (user decision). The "one-sided ride_payment minting" alarm was **seed/test data (316k) + the legit 2-txn mixed pattern** — not a bug.
- **P2 Money in (recharge/NETOPIA)** — ✅ all completed recharges credited correctly; webhook has the `failed→paid` recovery + ntpID guard (BUG-158 fix live); server validates amount (`Number.isFinite` + bounds).
- **P3 Pricing / estimate** — ✅ estimate→snapshot→charge parity exact (incl. discounts + wait). `pricing_rules` active (4/service) govern.
- **P4 Ride charge (`complete_ride_and_pay`)** — ✅ recent rides correct. Historical casualties of the cup_to_trc bug (`#c3c61627`, one 05-30 ride) are pre-00379, test data. Commission routes to `tricicoin→platform_revenue` (April `driver_cash` commissions are legacy).
- **P5 Secondary flows** — ✅ tips → tricicoin (balanced); cargo bonus → tricicoin (00390); gifts context-aware (00391); cancellation reputational ($0). Insurance/corporate/splits/referrals: **dormant/near-zero usage**.
- **P6 Money out / reconciliation** — ✅ no cash-out flow (closed-loop by design); refunds admin-gated; `platform_revenue` reconciles exactly.
- **P7 Money display (UI/UX)** — the "big" candidate (client wallet `ledger_entries[0]`) was a **false positive** (customer never multi-entry; sign from actual amount). Remaining items are minor (see below).
- **P8 Prevention** — this doc + `supabase/money-health-check.sql`.

## Findings ledger

| ID | Phase | Lens | Severity | Status |
|---|---|---|---|---|
| F1-A | 1 | data | low | **Won't fix** — `driver_cash` legacy 290.5k trapped + 62k debt; test accounts, frozen, no live writer (user decision) |
| F1-B | 1 | method | — | **Not a bug** — one-sided `ride_payment` = seed data + 2-txn mixed pattern |
| F3-A | 3 | code | low | **Deferred** — `pricing_rule_id` NULL in snapshots (traceability only; rates correct per parity) |
| F3-B | 3 | logic | low | **Deferred** — 2 `auto_standard` estimates 90 below `min_fare`, both **canceled** (no charge); likely mensajería-flat quirk |
| F4-x | 4 | data | — | **Historical/fixed** — `#c3c61627` + 1 ride: pre-00379 cup_to_trc casualties (test data) |
| F7-A | 7 | code | — | **False positive** — client wallet `entry[0]` is correct (customer single-entry; sign from amount) |
| F7-B | 7 | UI | low | **Deferred** — driver "Recent activity" uses `entry[0]`; 2 mixed-ride rows show gross wallet portion vs net. Totals correct via `tripNetEarnings`. Fix: `signedLedgerAmountForAccount` (needs account_id threading) |
| F7-C | 7 | UX | low | **Deferred (needs decision)** — gift balance label: client "TC" vs driver "CUP" (branding) |
| F7-D | 7 | UI | low | **Deferred** — `TripCompleteView` toast hardcodes `$` for cash fares (hero already uses `fmtMoney`) |
| EF-1 | 2/7 | code | low | **Deferred** — `formatCup` duplicated in `generate-recharge-receipt` + `notify-business-movement` EFs instead of importing `@tricigo/utils` |

## Dormant / untested money paths (no prod usage; tests in scope if activated)
- **Insurance** — 0 rides ever selected it; no `insurance_premium` ledger type exists.
- **Corporate rides** — 0; the `complete_ride_and_pay` corporate-commission branch is unexercised.
- **Ride splits** — 0.
- **Referrals** — 1 old tiny txn (94), minimal usage.

## Already-fixed this cycle (verified in prod)
Mixed `wallet_ratio` (#447), tip display + realtime (#447), `cup_to_trc` 1:1 (00379/#414),
cargo bonus → tricicoin + email amount (00390/#392 family), gift source wallet context (00391/#450).

## Test coverage
- Pure logic (vitest): `currency`, `fareCalculator`, `farePresentation`, `signedLedgerAmountForAccount` (ledger), `createRide` `wallet_ratio` passthrough, `sendGift` `fromWallet`. ✅
- DB invariants: `supabase/money-health-check.sql` (run vs prod/staging). The RPC/EF bodies
  (`complete_ride_and_pay`, webhook) lack unit infra (Deno/pgTAP) — covered by the SQL health
  check + service-layer caller tests.
