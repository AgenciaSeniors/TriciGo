// ============================================================
// TriciGo Driver — Background Location Task
// ============================================================
// BUG-Store-Readiness-Driver (FD1): real background tracking via
// expo-task-manager + Location.startLocationUpdatesAsync.
//
// The previous implementation in useDriverLocation.ts only called
// Location.watchPositionAsync, which on Android stops invoking its
// callback the moment the app moves to background (or the screen
// turns off). That contradicted the promise in
// app-store-review-notes.md and broke the rider's expectation of
// seeing the driver's marker move while the driver had the
// TriciGo Conductor app minimized.
//
// This module defines a TaskManager task that the OS keeps alive
// inside a foreground service (Android) or via the
// UIBackgroundModes=location entitlement (iOS). The task continues
// to receive location callbacks even when the driver minimizes the
// app to take a phone call, switches to a navigation app, or turns
// the screen off.
//
// Lifecycle:
//   - useDriverLocation calls `startBgLocationTracking(ctx)` whenever
//     the driver is ONLINE (with or without an active ride) AND
//     background permission is granted. The function persists `ctx`
//     (driverId, rideId, mode) to SecureStore and starts
//     startLocationUpdatesAsync with a foreground service notification.
//   - Two modes:
//       * 'online' — driver is online waiting for offers. Low-frequency
//         location + heartbeat. The foreground service keeps the JS
//         runtime alive so the driver's `last_heartbeat_at` keeps
//         refreshing even when the app is minimized / screen off.
//         Without this, backgrounding the app stopped the heartbeat and
//         the `auto-offline-stale-drivers` cron (10 min) — plus the
//         3-min `accept_ride_v2` gate — silently suspended the driver.
//       * 'ride' — driver has an active trip. High-frequency location so
//         the rider sees the marker move in real time, plus heartbeat.
//   - The TaskManager task (defined at module scope below) reads the
//     persisted ctx, ALWAYS refreshes the heartbeat, and (only when a
//     rideId is present) uploads each batch of locations via
//     locationService.recordRideLocation, falling back to the
//     locationBuffer if the upload fails (network down, etc.).
//   - useDriverLocation calls `stopBgLocationTracking()` when the
//     driver goes offline. The function stops the task and clears the
//     persisted ctx.
//
// Constraints:
//   - This module's `TaskManager.defineTask` call MUST run before
//     the OS can fire the task. Achieved by importing the module
//     for its side effects from `apps/driver/app/_layout.tsx`.
//   - The task body runs WITHOUT React state. It has access only to
//     module-scoped imports and the persisted ctx. Hence the
//     SecureStore round-trip on every batch.
//   - Inside the task, `locationService.recordRideLocation` uses
//     the Supabase client, which reads the access token from
//     SecureStore via the storage adapter wired in useAuth. As long
//     as a valid session is persisted, uploads succeed. If the
//     token has expired, Supabase auto-refreshes; if refresh fails,
//     the upload errors and we buffer for later.

import { AppState } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { driverService, locationService } from '@tricigo/api';
import { bufferLocation, newClientEventId, type BufferedLocation } from './locationBuffer';
import { SECURE_STORE_SERVICE } from '@/lib/secureStoreService';

export const LOCATION_TASK = 'tricigo-driver-location-bg';
const CTX_KEY = 'tricigo_bg_location_ctx';

// iOS only: expo-secure-store defaults to WHEN_UNLOCKED, which makes the item
// unreadable while the device is LOCKED — precisely when this task runs, with
// the phone locked in the driver's pocket. AFTER_FIRST_UNLOCK keeps the ctx
// encrypted at rest until the first unlock after boot, then readable while
// locked. No-op on Android. Must match the options used in
// apps/driver/src/hooks/useAuth.ts for the session. See Sentry TRICIGO-MOBILE-14
// and SECURE_STORE_SERVICE for why the service rename is what makes it stick.
const CTX_STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  keychainService: SECURE_STORE_SERVICE,
};

/**
 * Read the ctx, falling back to where it lived before the service rename.
 *
 * Returns the raw string, or throws if the keychain refused us — the caller has
 * to tell "unreadable" from "absent" apart. The fallback matters for the upgrade
 * itself: without it, the first batch after the update would find nothing under
 * the new service and stop the task, dropping a mid-shift driver offline until
 * he next opened the app. The legacy copy is not adopted (unlike the session):
 * the ctx is disposable, and the next persistBgTaskContext supersedes it.
 */
async function readBgTaskContextRaw(): Promise<string | null> {
  const current = await SecureStore.getItemAsync(CTX_KEY, CTX_STORE_OPTIONS);
  if (current !== null) return current;
  return SecureStore.getItemAsync(CTX_KEY);
}

export type BgTaskMode = 'online' | 'ride';

interface BgTaskContext {
  driverId: string;
  // null while the driver is online but has no active trip yet.
  rideId: string | null;
  mode: BgTaskMode;
}

// The mode the foreground service was ACTUALLY started with (its real update
// frequency), as opposed to the desired `mode` persisted in the ctx (which the
// task body reads to decide whether to record ride locations). These diverge
// when a mode change is deferred because the app is backgrounded (see
// startBgLocationTracking). Module-scoped: valid while the JS runtime is alive
// (the foreground service keeps it alive); resets to null if the process is
// killed and relaunched, in which case the task is no longer registered and the
// next call takes the initial-start path.
let startedMode: BgTaskMode | null = null;

/**
 * Persist context the TaskManager task needs to upload locations.
 * Called by the React hook before starting the task.
 */
export async function persistBgTaskContext(ctx: BgTaskContext): Promise<void> {
  try {
    // A plain write, deliberately. Never delete-then-write here: this runs on
    // every AppState → 'active' (useDriverLocation → startBgLocationTracking),
    // the `await` yields the JS thread, and a location batch landing in that gap
    // would read the ctx as ABSENT — which the task body reads as "the driver
    // signed out" and answers with stopLocationUpdatesAsync(), unregistering
    // itself. startBgLocationTracking captured isRunning before this call, so it
    // would not restart it either: the shift would die exactly the way
    // TRICIGO-MOBILE-14 kills it. The service rename (CTX_STORE_OPTIONS) is what
    // gets AFTER_FIRST_UNLOCK applied — the first write under the new service is
    // a SecItemAdd — so no delete is needed to migrate.
    await SecureStore.setItemAsync(CTX_KEY, JSON.stringify(ctx), CTX_STORE_OPTIONS);
  } catch {
    // best-effort — if SecureStore fails, the task will skip uploads
  }
}

/**
 * Clear the persisted ctx. Called when the ride completes or driver
 * goes offline so the next session starts clean.
 */
export async function clearBgTaskContext(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CTX_KEY, CTX_STORE_OPTIONS);
  } catch {
    // best-effort
  }
  try {
    // Also the pre-rename copy, which readBgTaskContextRaw still falls back to —
    // leaving it behind would resurrect a stale driverId/rideId after a stop.
    await SecureStore.deleteItemAsync(CTX_KEY);
  } catch {
    // best-effort
  }
}

// Per-mode location update options.
//   - 'ride': high frequency so the rider sees the marker move in real
//     time (matches the foreground watchPositionAsync cadence).
//   - 'online': low frequency to save battery while the driver is just
//     waiting for offers. The heartbeat (below) is what keeps the driver
//     matchable; the foreground service keeps the JS runtime alive so the
//     hook's setInterval heartbeats also keep firing in background.
function updateOptionsForMode(mode: BgTaskMode) {
  const foregroundService = {
    notificationTitle: 'TriciGo Conductor',
    notificationBody:
      mode === 'ride'
        ? 'Compartiendo tu ubicación con el pasajero durante el viaje activo.'
        : 'Estás en línea. Puedes recibir viajes con la app en segundo plano.',
    notificationColor: '#111111',
  };
  if (mode === 'ride') {
    return {
      accuracy: Location.Accuracy.High,
      timeInterval: 3000, // 3 s minimum between callbacks
      distanceInterval: 10, // 10 m minimum movement before a callback
      showsBackgroundLocationIndicator: true, // iOS blue bar
      foregroundService,
    };
  }
  return {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 60_000, // ~1 fix/min — enough to refresh the heartbeat
    distanceInterval: 0, // time-based, not movement-gated (stationary driver)
    showsBackgroundLocationIndicator: true,
    foregroundService,
  };
}

/**
 * Start real background location tracking while the driver is online.
 * Idempotent within a mode — safe to call multiple times. When the mode
 * changes (online ⇄ ride) the task is stopped and restarted so the new
 * frequency and notification take effect.
 *
 * (For the record, the explicit stop is belt-and-braces rather than strictly
 * required on Android: expo-task-manager routes a re-register of an existing
 * task to `setOptions` — TaskService.java:112-114 — which LocationTaskConsumer
 * implements as stop + start + maybeStartForegroundService. It is kept because
 * it is the behaviour we have shipped and verified, and because the restart is
 * only ever reached with the app foregrounded anyway.)
 *
 * On iOS, `showsBackgroundLocationIndicator` shows the blue location
 * indicator in the status bar while the app is in background — Apple
 * requires this for any app that uses UIBackgroundModes=location.
 *
 * On Android, `foregroundService` declares a persistent notification
 * that informs the driver the app is tracking their location. Required
 * by Android 8+ for any background location use; mandatory for the
 * `FOREGROUND_SERVICE_LOCATION` permission on Android 14+.
 */
export async function startBgLocationTracking(ctx: BgTaskContext): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);

  // Persist the desired ctx first — the task body reads driverId/rideId from
  // it on every batch, regardless of whether we (re)start below.
  await persistBgTaskContext(ctx);

  // Not running yet → initial start. Without ACCESS_BACKGROUND_LOCATION (which
  // we no longer require — the foregroundService option exempts us) Android
  // rejects starting a location foreground service from the background with
  // ForegroundServiceStartNotAllowedException.
  //
  // The two call sites in useDriverLocation only reach here with
  // AppState === 'active', which is what makes those legal. The demote path is
  // NOT so constrained: unbindBgLocationFromRide fires from the 5s cancellation
  // poll, which runs while minimized. When it does, this throws, the caller
  // swallows it, and the ctx persisted just above still took effect — so the
  // upload unbinding lands even though the (re)start did not. The AppState
  // 'active' listener retries later. That is the intended shape, not a leak.
  if (!isRunning) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptionsForMode(ctx.mode));
    startedMode = ctx.mode;
    return;
  }

  // Running at the desired frequency already → nothing to do; the task picks up
  // the new rideId from the persisted ctx on its next batch.
  if (startedMode === ctx.mode) {
    return;
  }

  // The running frequency differs from what we want (online ⇄ ride). Applying
  // the new frequency/notification requires a stop+restart, but restarting a
  // location foreground service from the background is blocked on Android 12+
  // (ForegroundServiceStartNotAllowedException). If we're not in the
  // foreground, SKIP the restart: the service keeps running at its current
  // frequency (`startedMode` unchanged) while the task already reads the new
  // mode/rideId from the persisted ctx (so heartbeat + ride-location recording
  // stay correct). The AppState 'active' listener in useDriverLocation
  // re-applies the intended frequency on the next foreground. This is the key
  // guard for a ride that ends — or an auto-accepted ride that starts — while
  // the app is minimized.
  if (AppState.currentState !== 'active') {
    return;
  }
  try {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // best-effort
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK, updateOptionsForMode(ctx.mode));
  startedMode = ctx.mode;
}

/**
 * Drop the ride binding but KEEP the service (and its heartbeat) alive.
 *
 * Call this when a trip ends while the driver stays on shift. Stopping the
 * service there looked harmless for as long as it never actually ran — before
 * the FGS start was un-gated from ACCESS_BACKGROUND_LOCATION, most drivers had
 * no service to stop. Once it did run, `stopBgLocationTracking()` on completion
 * became a guaranteed disconnection: `useDriverLocation`'s tracking effect is
 * keyed on [driverId, isOnline, activeRideId], and the completed trip is KEPT
 * in the store so the earnings screen can render it — so activeRideId does not
 * change, the effect does not re-run, and nothing restarts the service. The
 * driver pocketed the phone on the earnings screen, JS suspended, both
 * foreground heartbeat timers froze, and `auto_offline_stale_drivers` pulled
 * them off line ~10 min later.
 *
 * Demoting instead satisfies the reason the stop existed — "don't keep
 * uploading against a finished ride_id" — because the task body returns early
 * when ctx has no rideId (see `if (!ctx.rideId) return;` below), right AFTER
 * the heartbeat. And `startBgLocationTracking` persists the new ctx before it
 * decides whether to restart, so the upload stops immediately even when the
 * app is backgrounded and the restart is (correctly) skipped.
 *
 * ACCEPTED TRADE-OFF — when the ride ends while the app is BACKGROUNDED (the
 * passenger cancelling, caught by the 5s poll, which keeps running precisely
 * because this service keeps the JS runtime alive), the restart is skipped and
 * the service is left at ride cadence: Accuracy.High, 3s/10m, still showing the
 * "sharing your location during the active trip" notification. It self-corrects
 * on the next foreground, via the AppState reconcile in useDriverLocation.
 *
 * There is no way around it. expo-location refuses ANY JS-side start carrying a
 * foregroundService while backgrounded, before it can even reach the setOptions
 * path — LocationModule.kt:257-259 of expo-location 55.1.8:
 *
 *     if (!AppForegroundedSingleton.isForegrounded && options.foregroundService != null)
 *       throw ForegroundServiceStartNotAllowedException()
 *
 * So the real choice is extra battery until the next foreground, or a stopped
 * service and no heartbeat at all. The heartbeat wins: without it the driver is
 * taken off line within ~10 minutes and stops earning.
 *
 * Callers should route through `unbindBgLocationFromRide` in useDriverRide.ts
 * rather than calling this directly — demoting can START a service, so it must
 * not run for an off-shift driver. `stopBgLocationTracking` stays for what it
 * says it is for: the driver going off shift, and teardown.
 */
export async function demoteBgLocationToOnline(driverId: string): Promise<void> {
  await startBgLocationTracking({ driverId, rideId: null, mode: 'online' });
}

/**
 * Stop background location tracking. Called when the driver goes offline or
 * the app tears down — NOT when a ride ends while they stay on shift, which
 * is what `demoteBgLocationToOnline` is for.
 */
export async function stopBgLocationTracking(): Promise<void> {
  startedMode = null;
  const isRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);
  if (isRunning) {
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    } catch {
      // best-effort
    }
  }
  await clearBgTaskContext();
}

// ──────────────────────────────────────────────────────────────
// TaskManager task definition (runs at module scope on import)
// ──────────────────────────────────────────────────────────────

interface LocationTaskData {
  locations?: Location.LocationObject[];
}

// Throttle the background heartbeat to ~once per minute. In 'ride' mode the
// OS delivers a location batch every few seconds; without this we'd write a
// heartbeat — and, via the `audit_driver_profiles` trigger, an audit row — on
// every batch, and add an RPC round-trip of latency before each ride-location
// upload. 60s matches the foreground heartbeat cadence (useDriverLocation +
// index.tsx), so this adds no write load beyond what already exists.
// Module-scoped: the foreground service keeps the JS runtime alive so this
// persists across batches; if the OS relaunches a killed task it resets to 0
// and the first batch heartbeats immediately (harmless).
let lastBgHeartbeatMs = 0;
const BG_HEARTBEAT_MIN_INTERVAL_MS = 55_000;

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.error('[bg-location-task] error:', error);
    return;
  }

  const { locations } = (data ?? {}) as LocationTaskData;
  if (!locations || locations.length === 0) return;

  // Load ctx fresh on every batch — handles the case where the user
  // accepts a new ride after the previous one ends (ctx is re-persisted
  // by useDriverLocation in that case).
  // "Could not read the ctx" and "there is no ctx" are NOT the same thing, and
  // conflating them cost drivers their shift: on iOS the keychain rejects reads
  // while the device is locked (errSecInteractionNotAllowed), so a locked phone
  // in the driver's pocket looked exactly like a signed-out driver and this task
  // shut its own location updates down — killing the heartbeat and making the
  // driver unmatchable until he relaunched the app (Sentry TRICIGO-MOBILE-14).
  // Reads should now succeed (CTX_STORE_OPTIONS), so this flag is the safety net.
  let raw: string | null = null;
  let ctxReadFailed = false;
  try {
    raw = await readBgTaskContextRaw();
  } catch {
    ctxReadFailed = true;
  }

  let ctx: BgTaskContext | null = null;
  if (raw) {
    try {
      ctx = JSON.parse(raw) as BgTaskContext;
    } catch {
      // Corrupt ctx — genuinely unusable, so fall through to the stop path
      // rather than keeping a no-op task alive forever.
      ctx = null;
    }
  }

  if (!ctx) {
    if (ctxReadFailed) {
      // Unreadable, not absent. Skip this batch but stay registered — the next
      // one (or the first after an unlock) reads the ctx and resumes uploading.
      return;
    }
    // Genuinely no ctx persisted — likely the task was started by the OS after
    // a crash recovery, but the user hasn't logged back in. Stop the task to
    // avoid burning battery on no-op callbacks.
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
    return;
  }

  // Refresh the heartbeat from the background task (throttled to ~60s). This
  // is the core fix for "driver goes inactive after minimizing the app":
  // while online-but-waiting the foreground JS timers are suspended by the
  // OS, so this task-body heartbeat keeps `last_heartbeat_at` fresh and the
  // driver matchable. driver_heartbeat is SECURITY DEFINER and uses the
  // persisted session, so it works headless. Best-effort — never throw out
  // of the task.
  const nowMs = Date.now();
  if (nowMs - lastBgHeartbeatMs > BG_HEARTBEAT_MIN_INTERVAL_MS) {
    lastBgHeartbeatMs = nowMs;
    try {
      await driverService.sendHeartbeat(ctx.driverId);
    } catch (hbErr) {
      console.warn('[bg-location-task] heartbeat failed:', hbErr);
    }
  }

  // Ride-location upload only makes sense during an active trip. When the
  // driver is merely online (rideId null), the heartbeat above is the only
  // work this task does.
  if (!ctx.rideId) return;
  const rideId = ctx.rideId;

  // 00537 (incident b428022b): TaskManager delivers fixes ALSO while the app
  // is foregrounded, where useDriverLocation's watcher is already appending
  // the trail via update_driver_position — running both produced duplicated
  // trail rows with mixed clocks. Single-pipeline rule: the watcher owns the
  // trail while the app is active; this task owns it in background/headless.
  // Only skip on an explicit 'active' — 'background'/'inactive'/'unknown'
  // (headless launch) must keep uploading.
  if (AppState.currentState === 'active') return;

  // Upload each location. recordRideLocation hits the
  // `ride_location_events` table which has RLS allowing the driver to
  // INSERT their own rows. If the upload fails (offline, token
  // expired), buffer for later flush by the foreground hook on next
  // network event.
  for (const loc of locations) {
    // 00537: mint the idempotency id at capture and carry the REAL fix
    // timestamp + accuracy. Without recorded_at the row got the server
    // insert time — the mixed-clock duplicate signature from the incident.
    const clientEventId = newClientEventId();
    try {
      await locationService.recordRideLocation({
        ride_id: rideId,
        driver_id: ctx.driverId,
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        heading: loc.coords.heading ?? undefined,
        speed: loc.coords.speed ?? undefined,
        accuracy: loc.coords.accuracy ?? null,
        recorded_at: new Date(loc.timestamp).toISOString(),
        client_event_id: clientEventId,
      });
    } catch (uploadErr) {
      const buffered: BufferedLocation = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        heading: loc.coords.heading ?? null,
        speed: loc.coords.speed ?? null,
        accuracy: loc.coords.accuracy ?? null,
        timestamp: loc.timestamp,
        rideId: rideId,
        driverId: ctx.driverId,
        // Same id as the failed attempt: if the upload actually committed
        // server-side (timeout-but-committed), the flush replay dedupes.
        clientEventId,
      };
      bufferLocation(buffered);
      console.warn('[bg-location-task] upload failed, buffered:', uploadErr);
    }
  }
});
