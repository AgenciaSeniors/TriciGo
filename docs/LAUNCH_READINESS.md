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

- [x] **G1** — restore commission affordability gate in `accept_ride_v2`. *Migration `00367` **applied to prod** and verified (Luis, balance 0 → blocked; Papa → allowed).*
- [x] **G2** — persist a sustained-offline completion via `executeOrQueue` + flush on reconnect. *Implemented (`ride.complete` handler + driver wiring + tests).*
- [x] **G3** — error boundaries in both apps. *(already implemented)*
- [x] **G4** — Sentry `captureException` wired. *(already implemented)*
- [ ] **D** — run the 3 scenario tests on device (double-accept, busy driver, offline) and capture screenshots. *Playbook: `docs/SCENARIO_TESTS.md`.*
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

---

# Round 2 — more everyday edge cases (2026-06-01)

Second pass auditing additional real-world scenarios, **grounded against prod**. Headline: at current volume (7 drivers, 173 rides, 122 canceled) **almost none of these paths have fired** — this is preventive correctness, not active bugs.

## Scenario: customer / driver cancellations
✅ **Implemented and live.** `cancel_ride` calls `apply_cancellation_fee` + `apply_cancellation_penalty` (both confirmed live).
- **Customer fee** (`cancellation_fee_configs`): free while `searching` or within the free window after accept; then en-route / arrived / in-progress fees. **0 fees charged ever** so far (all real cancels were free-window/searching at this volume).
- **Driver penalty** (`cancellation_penalties`): progressive amount per 24h. **Exercised: 39 rows, 18 with a charge > 0.** Works.
- **Notification**: push + SMS triggers fire on status → canceled.
- **Note:** `cancellation_penalties` has NO `is_blocked` column — the "block after 5th cancel" described by exploratory tooling was stale; the live table only records `amount`/`reason`.

**Deferred (documented, not blocking):**
- No auto **re-dispatch** when the *driver* cancels — the customer must re-request. *Why deferred:* UX friction, not data loss; low volume.
- No status guard: a driver can call `cancel_ride` on an `in_progress` trip (no fee, but the progressive penalty still applies). *Why deferred:* penalty already disincentivizes; rare.
- `cancellation_reason` is free text (no controlled vocabulary). *Why deferred:* analytics nicety.

## Scenario: payment failure / negative balance
**Dormant at current volume.** **0 negative `tricicoin` balances** (the −61,804 are legacy `driver_cash`, BUG-211). All 173 rides are `payment_status='not_applicable'` — the async ride-payment path (tropipay/netopia *for rides*) has **never** been exercised (NETOPIA is only used for wallet recharges via `payment_intents`).
- `complete_ride_and_pay` (live 00340) debits commission from `tricicoin`; **no negative guard at completion**, so in theory a driver could go negative — but the **G1 accept-time gate (00367) now blocks accepting without enough balance**, which is the practical mitigation.
- **Deferred:** retry/reconciliation for a stuck async ride payment. *Why deferred:* path is dormant; no real occurrences.

## Scenario: app killed mid-trip (crash recovery)
✅ **Solid.** Both apps reconcile from the server on mount (`getActiveTrip` / `getActiveRide`), keep local state on network error with retry, and the driver's background location task persists `{driverId, rideId}` to SecureStore so it survives a kill.
- **Fixed this round (F3):** the background task kept the *old* `ride_id` after a completion (the store retains the completed trip for the earnings screen, so `useDriverLocation`'s effect cleanup didn't fire) → it could upload locations against a finished ride. Now `useDriverRide` calls `stopBgLocationTracking()` on completion (online + offline-queued paths) and on cancel.

## Scenario: fraud / abuse / duplicate requests
- **Duplicate / double-tap** ✅ — `rides_one_active_per_customer` partial unique index + trigger + client `isSubmittingRef` debounce. 2nd request gets `customer_has_active_ride`.
- **Ride-creation rate limit** — **was missing; fixed this round (F1).** New trigger `trg_rides_rate_limit` (migration `00368`) calls `check_rate_limit('ride_create:<uid>', 6, 60)` only for customer-initiated inserts (skips cron/service_role). Complements the active-ride index (which only caps concurrent, not sequential create→cancel spam). Client maps `ride_rate_limited` to a friendly toast.
- **Self-ride** (customer == driver) — **accepted by product** (per CLAUDE.md); commission still flows; no guard by design.
- **GPS mock / spoofed location** — ❌ **no detection (DEFERRED).** A driver using a fake-GPS app can fake arrival/distance. `update_ride_status_v2` proximity gate checks distance, not authenticity. *Why deferred this round:* needs `expo-location` mock-flag plumbing + policy on how to react; owner chose to defer. **Recommended before scaling driver supply.**
- **Distance fraud at completion** — mitigated: client clamp (1.5× / 100 km ceiling) + server cap (1.3× of estimate inside `complete_ride_and_pay`). Raw `actual_distance_m` stored for audit.
- **Proximity override** — 5-min consent window, no attestation. *Deferred:* low risk at volume.

## G5 — scale readiness (read-only analysis)
Hot path: `createRide → dispatch_ride → find_best_drivers` (spatial `ST_DWithin` on `driver_profiles`) → insert N `ride_offers` → trigger `notify_driver_new_offer` (one `pg_net.http_post` **per offer**).
- **Indexes are in place** ✅: `idx_driver_profiles_location` (GIST on `current_location`); `ride_offers` has `(driver_profile_id,status,expires_at)`, `(ride_id,status)`, and the unique `(ride_id,driver_profile_id)`. The spatial match and offer lookups are indexed — no obvious missing-index bottleneck.
- **Primary scale risk: push fan-out.** Each dispatch round inserts ~10 offers, each firing a `pg_net.http_post` to `send-push`. At high concurrency this is the most likely pressure point (HTTP fan-out + the per-minute crons scanning `ride_offers`/`rides`).
- **Recommended load test (NOT on prod):** on a Supabase **branch**, seed synthetic online drivers around a city center + drive N concurrent `createRide` calls; measure `dispatch_ride`/`find_best_drivers` latency and `pg_net` queue depth. Define thresholds (e.g. dispatch p95 < 2s at X concurrent requests) before opening a city. Deferred to an ops task — current volume doesn't require it yet.

## Round-2 checklist
- [x] **F1** — ride-creation rate limit (migration `00368` + client toast). *Migration committed; apply to prod pending explicit authorization.*
- [x] **F3** — stop background location on completion/cancel (driver).
- [ ] **GPS mock detection** — deferred; recommended before scaling driver supply.
- [ ] **Load test on a branch** — deferred ops task; indexes already verified present.
