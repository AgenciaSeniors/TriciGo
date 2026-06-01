# Scenario Tests — concurrency & offline (launch QA playbook)

Runnable procedures to **see** how the app handles the everyday race conditions and failure modes from `LAUNCH_READINESS.md`. Three layers: (A) read-only invariant checks against prod, (B) live two-device tests, (C) device offline test. None of these mutate production data.

> **Setup tip:** to populate the map with vehicles while testing (so you're not staring at an empty map waiting for real drivers), turn on the **dev/demo vehicle-preview toggle** (orange car button) added in the test-vehicle feature. Gated to `__DEV__ || EXPO_PUBLIC_DEMO_MODE`.

---

## Scenario 1 — Two drivers accept the same ride

### A. Invariant check (read-only, run anytime against prod)
Proves the storage-layer guarantee is armed and currently has zero violations:
```sql
-- Must always return 0. If >0, the partial unique index failed and there's a real bug.
SELECT COUNT(*) AS drivers_with_multiple_active_rides FROM (
  SELECT driver_id FROM rides
  WHERE driver_id IS NOT NULL
    AND status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
  GROUP BY driver_id HAVING COUNT(*) > 1
) d;
```
Last run (2026-06-01): **0** ✅.

Historical evidence the guard actually fires in real life:
```sql
SELECT outcome, COUNT(*) FROM rpc_attempt_log
WHERE rpc_name='accept_ride_v2' GROUP BY outcome;
-- 77 success, 1 ride_already_taken (2026-04-23), 12 insufficient_balance, ...
```

### B. Live two-device test (the real thing)
1. Devices: **D1** + **D2** (two driver dev clients), both online, both within range of the pickup. Use two approved test drivers (e.g. *Carlos Test Triciclo*, *Pedro Test Auto*).
2. **R** (rider device or rider dev build) requests a ride of a type both D1 and D2 serve.
3. Both D1 and D2 receive the offer card. **Tap ACCEPT on both as close to simultaneously as possible.**
4. **Expected:** exactly one driver lands on the active-trip screen. The other gets a toast — "El viaje ya fue aceptado" (`ride_already_taken`) or "Ya tenés un viaje activo" (`driver_has_active_ride`, `race:true`) — and the offer card disappears. The rider sees exactly one assigned driver.
5. Re-run the invariant query (A) → still 0.

---

## Scenario 2 — Request reaches a driver already on a trip

1. Put **D1** on an active trip (accept a ride, advance to `in_progress`).
2. **R** requests a second ride of the same type from a nearby pickup.
3. **Expected:** D1 does **not** receive an offer (filtered by `find_best_drivers`). If you force a stale offer and tap accept, it's rejected with `driver_has_active_ride`.

Verification:
```sql
-- Drivers currently eligible to be offered (online, approved, no active ride)
SELECT u.full_name, dp.is_online, dp.status
FROM driver_profiles dp JOIN users u ON u.id=dp.user_id
WHERE dp.is_online AND dp.status='approved'
  AND NOT EXISTS (
    SELECT 1 FROM rides r WHERE r.driver_id=dp.id
      AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress','arrived_at_destination')
  );
```

---

## Scenario 3 — No internet

### C. Device airplane-mode test
**Rider, during search:**
1. Rider requests a ride; while "buscando conductor", enable airplane mode.
2. **Expected:** "Sin conexión" banner appears. The search state persists (no crash). On reconnect, realtime/poll resumes and a driver can still be assigned.

**Driver, mid-trip:**
1. Driver on an active trip; enable airplane mode.
2. GPS keeps buffering locally (up to 500 points) — no crash, no error spam.
3. Tap **Finalizar viaje** while offline:
   - **Today:** `completeRide` retries 3× with backoff. If still offline, it surfaces an error and the trip stays `in_progress`. (G2 fix will queue it for replay on reconnect.)
4. Disable airplane mode → buffered GPS flushes; re-tap Finalizar → completes and pays.

**What to watch in Metro logs:** `[useNearbyVehicles] fetched`, location buffer flush messages, and absence of unhandled-rejection stacks (the rejection tracker + ErrorBoundary should keep the app alive).

---

## Quick health gate before launch day
```sql
SELECT jobname, active FROM cron.job
WHERE jobname IN ('expire-ride-offers','retry-dispatch-expired-rides',
                  'cleanup_orphan_searching_rides','auto-offline-stale-drivers');
-- all must be active = true
```
