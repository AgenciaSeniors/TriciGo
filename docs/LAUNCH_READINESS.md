# Launch Readiness — Concurrency, Everyday Edge Cases & Offline

> **Scope.** This report answers a specific question: *how does TriciGo behave under the everyday race conditions and failure modes that generate bugs in ride-hailing apps, and is it ready to launch?* It focuses on the **ride lifecycle** (dispatch → accept → trip → complete), **concurrency**, and **offline/network resilience**. It does NOT re-cover store compliance, payments, or security (see `PRODUCTION_READINESS.md`, `SECURITY_REMEDIATION.md`, `STORE_RELEASE.md`).
>
> **Method.** Every claim was verified against **production** (project `lqaufszburqvlslpcuac`) via `pg_get_functiondef`, `pg_indexes`, `cron.job`, and `rpc_attempt_log` — not just the migrations in git. Verification date: 2026-06-01.

---

## TL;DR — Verdict

| Dimension | Verdict |
|---|---|
| **Transactional integrity (double-accept, busy driver, no orphan rides)** | ✅ **GO** — provably correct, verified live, 1 real collision handled cleanly in prod. |
| **Dispatch resilience (no-one-accepts, retries, timeouts)** | ✅ **GO** — broadcast + 3-round escalation + auto-cancel, all crons live. |
| **Driver eligibility gates (approved / online / heartbeat / fleet)** | ✅ **GO** — enforced server-side. |
| **Commission affordability gate** | ⚠️ **CONDITIONAL** — accept-time balance gate was removed (G1). Bounded but should be restored before scaling driver count. |
| **Crash safety + observability (error boundaries, Sentry)** | ✅ **GO** — already implemented (G3/G4 closed; see correction below). |
| **Offline / network resilience** | ⚠️ **CONDITIONAL** — good GPS buffering + banners + completion retry, but a *sustained*-offline ride completion isn't persisted for replay (G2). UX gap, not data-integrity. |
| **Battle-testing at scale** | ⚠️ Only 7 approved drivers / 51 completed rides. Logic is correct; throughput is unproven. |

**Bottom line:** the **money-and-state core is launch-safe** — you cannot double-book a driver or a ride, and the dispatcher degrades gracefully. Crash safety and error reporting are in place. The two remaining conditional items are **G1** (commission-debt regression) and **G2** (persist a completion that fails after sustained offline). Neither corrupts data; both are worth closing before a public launch with real driver volume.

> **Correction (verified live during this audit):** the initial exploration flagged "no error boundaries (G3)" and "Sentry not capturing (G4)" — **both are wrong.** `packages/ui/src/ErrorBoundary.tsx` exists and wraps the tree in `apps/{client,driver}/app/_layout.tsx` with `onError={(e) => Sentry.captureException(e)}`; both apps also use `Sentry.wrap(RootLayoutInner)` and install a promise-rejection tracker via `setupRuntimeLogging()` before Sentry init. G3/G4 are **closed**. The only optional polish left is capturing the handful of intentionally-silent `.catch(() => {})` blocks in the ride flow.

---

## 1. Scenario: request broadcast to many drivers — two accept at once

**What happens today:** Impossible to double-book. Dispatch is **broadcast** (`dispatch_ride` inserts up to ~10 `ride_offers` at once), but acceptance is serialized by three independent guards, all verified live:

1. **Row lock + status guard** in `accept_ride_v2`: `SELECT … FOR UPDATE` then requires `status='searching'`. The loser sees `ride_already_taken`.
2. **Partial unique indexes** (storage layer, can't be bypassed):
   - `rides_one_active_per_driver` — one active ride per driver.
   - `rides_one_active_per_customer` — one active ride per customer.
3. **`unique_violation` handler** in `accept_ride_v2` converts the race loss into a clean `driver_has_active_ride` (`race:true`) response.

**Evidence (prod):** `rpc_attempt_log` for `accept_ride_v2` → 77 success, **1 `ride_already_taken`** (2026-04-23) handled cleanly. The protection has already fired in real life.

**Driver UX:** loser gets a toast ("El viaje ya fue aceptado" / "Ya tenés un viaje activo") and the offer disappears.

**Severity:** none. **Verdict:** ✅ GO.

---

## 2. Scenario: request sent to a driver already on a trip

**What happens today:** Doubly prevented.
- **At dispatch:** `find_best_drivers` excludes drivers with an active ride — a busy driver is never offered.
- **At accept:** even on a stale offer, the `rides_one_active_per_driver` index + the `driver_has_active_ride` soft-check reject it.

**Severity:** none. **Verdict:** ✅ GO.

---

## 3. Scenario: no-one accepts / slow network on the rider side

**What happens today:** `dispatch_ride` offers expire after **30s** (`expire-ride-offers` cron, every 1 min). `retry-dispatch-expired-rides` (every 1 min) escalates the radius **5 km → 7.5 km → 10 km** over 3 rounds, notifying the rider each round, then auto-cancels with `no_drivers_accepted`. `cleanup_orphan_searching_rides` (every min) and `auto-offline-stale-drivers` (every 5 min) prevent stuck states. All crons confirmed **active** in prod.

**Known limitation:** the rider-side search loop never self-cancels client-side; it relies on the server auto-cancel. Acceptable.

**Severity:** low. **Verdict:** ✅ GO.

---

## 4. Scenario: driver not approved / offline / stale connection

**What happens today:** `accept_ride_v2` rejects with `driver_not_approved`, `driver_not_online`, stale-heartbeat (>3 min), and `not_in_fleet` (corporate rides). All confirmed live.

**Severity:** none. **Verdict:** ✅ GO.

---

## 5. Scenario: no internet connection

**What happens today — the good parts:**
- Connectivity detection via NetInfo; **"Sin conexión" banner** in both apps.
- **GPS buffering**: up to 500 points persisted to AsyncStorage, flushed on reconnect (`locationBuffer.ts`), with dedup so reconnect doesn't double-post.
- **Driver chat** queues outgoing messages and drains on reconnect.

**The remaining gap (G2):**
- **Trip completion is already resilient**: `completeRide` retries 3× with backoff and has idempotent recovery (BUG-263 — if the response is lost but the server completed, it reconstructs from the row). The gap is only the **sustained-offline** case: if all 3 retries fail (driver in a dead zone for minutes), the completion is dropped and the trip stays `in_progress` with no auto-replay on reconnect.
- **Accept** is deliberately NOT queued (a stale replayed accept would grab an expired/taken offer); it should just show a clear "sin conexión" message at accept time.

**Crash safety / observability are already in place** (error boundary + Sentry capture + rejection tracker — see correction in TL;DR).

**Severity:** low–medium (UX; not data corruption). **Verdict:** ⚠️ CONDITIONAL.

---

## Findings to fix (prioritized)

### G1 — Commission affordability gate regression ⚠️ (data/financial)
The live `accept_ride_v2` **no longer checks** whether the driver can afford the commission (12 historical `insufficient_balance` outcomes, none since 2026-04-28 → the gate was dropped by a later `CREATE OR REPLACE`). The upstream substitute, `find_best_drivers` filtering `is_financially_eligible=true`, does **not** compensate:
- `is_financially_eligible` is **static/manual** — no cron, no wallet/ledger trigger maintains it, and `check_accept_ride_eligibility` defaults it to **true** when null.
- **Live proof:** driver *Luis Manuel Calero* has `tricicoin = 0` but `is_financially_eligible = true`. He'd be offered rides and could accept, accruing commission debt. Negative balances already exist (e.g. Eduardo `driver_cash = −60,403`, BUG-211).
- `complete_ride_and_pay` has a partial negative guard, so the harm is bounded to commission debt rather than a crash — but the accept-time gate should be restored.

**Fix:** new migration `CREATE OR REPLACE accept_ride_v2` that re-adds a lightweight balance check before the UPDATE, reusing `driver_can_afford_commission` (still exists in prod). Per CLAUDE.md: copy the **live** body via `pg_get_functiondef`, insert the gate, return `insufficient_balance`. The driver app already maps that error to a toast.

### G2 — Sustained-offline completion not persisted ⚠️ (UX)
The robust offline system (`executeOrQueue`, `packages/api/src/lib/offlineQueue.ts`) auto-flushes on reconnect via `setOnlineStatus`, and already registers `ride.cancel`. But `completeRide` is NOT routed through it — so after its 3 in-line retries exhaust under sustained offline, the completion is lost.

**Fix (additive, low-risk):** when `completeRide`'s retry loop exhausts with a *network* error, enqueue `ride.complete` via `executeOrQueue` (register the handler in `offlineMutations.ts`) so it replays on reconnect. The RPC is idempotent (BUG-263 recovery), so replay is safe. Do NOT alter the existing retry/recovery logic. Leave `accept` un-queued (show a clear offline message instead).

### G3 — React error boundaries ✅ (already done)
`packages/ui/src/ErrorBoundary.tsx` wraps both apps in `app/_layout.tsx` with a retry fallback. **No action needed.**

### G4 — Sentry capture ✅ (already done)
Both apps call `Sentry.captureException` in the ErrorBoundary `onError`, use `Sentry.wrap(RootLayoutInner)`, and install a promise-rejection tracker via `setupRuntimeLogging()`. **No action needed.** *Optional polish:* capture the intentionally-silent `.catch(() => {})` blocks in the ride flow.

### G5 — Not stress-tested ⚠️ (confidence)
7 approved drivers, 51 completed rides. Logic is correct; concurrency at volume is unproven. Mitigated by the **scenario test harness** (Phase D) which forces the race/busy/offline cases on demand.

---

## Pre-launch checklist

- [ ] **G1** — restore commission affordability gate in `accept_ride_v2` (migration + per-PR auth + apply). *Blocking before onboarding paying drivers at volume.*
- [ ] **G2** — persist a sustained-offline completion via `executeOrQueue` + flush on reconnect.
- [x] **G3** — error boundaries in both apps. *(already implemented)*
- [x] **G4** — Sentry `captureException` wired. *(already implemented)*
- [ ] **D** — run the 3 scenario tests on device (double-accept, busy driver, offline) and capture screenshots.
- [ ] Re-confirm all dispatch crons remain `active` on launch day (`SELECT jobname, active FROM cron.job`).
- [ ] Decide a policy/automation to keep `is_financially_eligible` honest (or remove it in favor of the live accept-time gate).

## How to reproduce the evidence
```sql
-- Concurrency guards live in accept_ride_v2
SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='accept_ride_v2';
-- Partial unique indexes
SELECT indexname, indexdef FROM pg_indexes WHERE tablename='rides' AND indexname LIKE '%one_active%';
-- Dispatch crons
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%dispatch%' OR jobname LIKE '%offer%';
-- Real-world acceptance outcomes
SELECT outcome, COUNT(*) FROM rpc_attempt_log WHERE rpc_name='accept_ride_v2' GROUP BY outcome;
-- Eligibility flag vs balance (G1)
SELECT u.full_name, dp.is_financially_eligible, wa.balance
FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
LEFT JOIN wallet_accounts wa ON wa.user_id=dp.user_id AND wa.account_type='tricicoin'
WHERE dp.status='approved';
```
